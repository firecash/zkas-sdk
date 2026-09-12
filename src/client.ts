import { assertPaymentRequest, type PaymentSigner } from "./signer.js";
import type {
  DeviceSignature,
  Network,
  PaymentRequest,
  PrepareResponse,
  SendPart,
  SendProgress,
  SendStage,
  SubmitResponse,
  WalletBalance,
  WalletHistory,
  WalletStatus,
  SendResult,
} from "./types.js";

/**
 * Largest per-transaction fee the SDK authorizes unless the caller sets a
 * higher `maxFeeSompi` (0.1 ZKAS). The worst honest byte-priced fee — a
 * 6-spend standard transaction — is ~0.044 ZKAS.
 */
export const DEFAULT_MAX_FEE_SOMPI = 10_000_000n;

/**
 * Hard stop on the chunk loop: a standard transaction spends at most 6 notes,
 * so a badly fragmented wallet could otherwise loop for a very long time.
 */
const MAX_CHUNKS = 24;

/**
 * How long a prepared session stays usable. A session left open for longer
 * may be built on chain state that has since moved, so it is refused and the
 * payment must be prepared again from the current tip.
 */
const SESSION_TTL_MS = 5 * 60 * 1000;

const SOMPI_PER_ZKAS = 100_000_000n;

export class ZKasSdkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ZKasSdkError";
  }
}

export interface ZKasClientConfig {
  baseUrl: string;
  walletToken?: string;
  network: Network;
  fetch?: typeof globalThis.fetch;
}

export class ZKasClient {
  readonly #baseUrl: string;
  readonly #walletToken: string | undefined;
  readonly #network: Network;
  readonly #fetch: typeof globalThis.fetch;
  /** Sessions already submitted: submit is single-use, a replay is refused. */
  readonly #usedSessions = new Set<string>();
  /** When each open session was prepared, for the expiry check. */
  readonly #preparedAt = new Map<string, number>();

  constructor(config: ZKasClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#walletToken = config.walletToken;
    this.#network = config.network;
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ---- wallet lifecycle & state -------------------------------------------

  /** Daemon + wallet status. Check `missing_history` before trusting a balance. */
  async status(): Promise<WalletStatus> {
    return this.#request<WalletStatus>("GET", "/api/status");
  }

  async balance(): Promise<WalletBalance> {
    return this.#request<WalletBalance>("GET", "/api/wallet/balance");
  }

  /** Chain-derived history (survives seed restores, unlike device-local lists). */
  async history(): Promise<WalletHistory> {
    return this.#request<WalletHistory>("GET", "/api/wallet/history");
  }

  /**
   * Register a WATCH-ONLY wallet from a 96-byte full viewing key: the daemon
   * can sync and prepare payments but is powerless to authorize them. This is
   * the only registration path the SDK offers — a seed never belongs on a
   * hosted daemon. `birthdayDaa` bounds the initial scan; always pass it for
   * restored wallets so the daemon knows history before it is complete.
   */
  async watch(fvkHex: string, birthdayDaa = 0): Promise<{ address: string }> {
    return this.#request<{ address: string }>("POST", "/api/wallet/watch", { fvk_hex: fvkHex, birthday: birthdayDaa });
  }

  /**
   * Re-derive the wallet from the chain. The daemon REFUSES a rescan that
   * would lose sight of notes the connected node has pruned (HTTP 409); pass
   * `force` only after the user explicitly accepted that loss.
   */
  async rescan(force = false): Promise<{ rescanning: boolean }> {
    return this.#request<{ rescanning: boolean }>("POST", "/api/wallet/rescan", force ? { force } : {});
  }

  // ---- payments ------------------------------------------------------------

  /**
   * Send a payment, non-custodially: prepare on the daemon, verify and sign on
   * this device, submit. Splits across up to 24 standard transactions when the
   * wallet's notes require it (each chunk is independently verified and
   * signed). The signer bounds every chunk's fee by `maxFeeSompi`.
   */
  async send(
    signer: PaymentSigner,
    request: PaymentRequest,
    onStage?: (stage: SendStage, progress?: SendProgress) => void,
  ): Promise<SendResult> {
    assertPaymentRequest(request);
    const recipient = request.to.trim();
    // The recipient must belong to this client's network: a mainnet client
    // must never sign for a testnet address and vice versa.
    const wantPrefix = this.#network === "mainnet" ? "zkas:" : `zkas${this.#network}:`;
    if (!recipient.toLowerCase().startsWith(wantPrefix)) {
      throw new ZKasSdkError(`recipient ${recipient} is not on ${this.#network}`);
    }
    const fvk = await signer.fullViewingKeyHex();
    const maxFee = maxFeeOf(request);
    const chunking = request.allowChunking !== false;

    const parts: SendPart[] = [];
    let sent = 0n;
    let fees = 0n;
    let owed = request.amountSompi;
    let estimated = 1;
    let networkDomain: string | undefined;

    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const progress = (): SendProgress => ({
        part: chunk + 1,
        parts: Math.max(estimated, chunk + 1),
        sentSompi: sent,
        totalSompi: request.amountSompi,
      });

      onStage?.("preparing", progress());
      const prepared = await this.prepare(fvk, { ...request, amountSompi: owed }, chunking);
      // The envelope carries the prover's claimed intent. It is display data,
      // not authority — but it must still agree with what the user approved.
      // A daemon whose claims differ from the approval is not signing what
      // the user asked for, so stop before any key material is used.
      const claimed = prepared.preparedPayment;
      if (!/^[0-9a-fA-F]{64}$/.test(claimed.networkDomain)) {
        throw new ZKasSdkError("prover returned a malformed network domain");
      }
      if (networkDomain === undefined) {
        networkDomain = claimed.networkDomain.toLowerCase();
      } else if (claimed.networkDomain.toLowerCase() !== networkDomain) {
        throw new ZKasSdkError("prover changed the network domain mid-payment");
      }
      if (claimed.recipient.trim() !== recipient) {
        throw new ZKasSdkError("prover changed the recipient");
      }
      const { amount, fee, remaining } = readExactAmounts(prepared);
      if (amount < 0n || fee < 0n || remaining < 0n) {
        throw new ZKasSdkError("prover returned a negative amount");
      }
      if (readBigInt(claimed.amount, "prover claim") !== amount) {
        throw new ZKasSdkError("prover changed the requested amount");
      }
      if (amount + remaining !== owed) {
        throw new ZKasSdkError("prover changed the requested amount");
      }
      if (amount > 0n && chunk === 0 && remaining > 0n) {
        estimated = Number((request.amountSompi + amount - 1n) / amount);
      }
      // Plain-language refusal before any signing work; the signer would refuse
      // anyway (it reads the real fee from the bundle, not this figure).
      if (fee > maxFee) {
        throw new ZKasSdkError(
          `prover asked for a fee of ${zkas(fee)} ZKAS, above the approved maximum of ${zkas(maxFee)} ZKAS`,
        );
      }

      onStage?.("verifying", progress());
      onStage?.("signing", progress());
      const signatures = await signer.verifyAndSign({
        network: this.#network,
        recipient,
        amountSompi: amount,
        maxFeeSompi: maxFee,
        prepared,
      });

      onStage?.("broadcasting", progress());
      const result = await this.submit(prepared.session, signatures);
      const got = readExactAmounts({
        amount_sompi_exact: result.amount_sompi_exact,
        fee_sompi_exact: result.fee_sompi_exact,
      });
      parts.push({ txid: result.txid, amountSompi: got.amount, feeSompi: got.fee });
      sent += got.amount;
      fees += got.fee;

      if (remaining <= 0n) break;
      owed = remaining;
      if (chunk === MAX_CHUNKS - 1) {
        throw new ZKasSdkError(
          `sent ${zkas(sent)} ZKAS in ${parts.length} transactions, but ${zkas(owed)} ZKAS could not be sent: ` +
            `the wallet's balance is split across too many small notes. Consolidate and send the rest.`,
        );
      }
    }

    onStage?.("submitted");
    return { txid: parts[0]!.txid, txids: parts.map((p) => p.txid), parts, amountSompi: sent, feeSompi: fees };
  }

  async prepare(fvkHex: string, request: PaymentRequest, allowPartial = false): Promise<PrepareResponse> {
    const prepared = await this.#request<PrepareResponse>("POST", "/api/wallet/prepare", {
      fvk_hex: fvkHex,
      to: request.to.trim(),
      amount_sompi: request.amountSompi.toString(),
      ...(request.feeSompi === undefined ? {} : { fee: request.feeSompi.toString() }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      ...(allowPartial ? { allow_partial: true } : {}),
    });
    this.#preparedAt.set(prepared.session, Date.now());
    return prepared;
  }

  async submit(session: string, signatures: DeviceSignature[]): Promise<SubmitResponse> {
    if (this.#usedSessions.has(session)) {
      throw new ZKasSdkError("this session was already submitted");
    }
    const preparedAt = this.#preparedAt.get(session);
    if (preparedAt !== undefined && Date.now() - preparedAt > SESSION_TTL_MS) {
      throw new ZKasSdkError("this session has expired; prepare the payment again");
    }
    const result = await this.#request<SubmitResponse>("POST", "/api/wallet/submit", { session, sigs: signatures });
    this.#usedSessions.add(session);
    this.#preparedAt.delete(session);
    return result;
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (this.#walletToken !== undefined) headers.set("x-wallet-token", this.#walletToken);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        typeof value === "object" && value !== null && "error" in value
          ? String((value as { error: unknown }).error)
          : `wallet service returned ${response.status}`;
      throw new ZKasSdkError(message, response.status, value);
    }
    return value as T;
  }
}

/** The effective per-transaction fee ceiling of a request: the caller's ceiling
 * or the standing default, never below the caller's own fee floor. */
export function maxFeeOf(request: PaymentRequest): bigint {
  const base = request.maxFeeSompi ?? DEFAULT_MAX_FEE_SOMPI;
  return request.feeSompi !== undefined && request.feeSompi > base ? request.feeSompi : base;
}

function zkas(sompi: bigint): string {
  const whole = sompi / SOMPI_PER_ZKAS;
  const frac = (sompi % SOMPI_PER_ZKAS).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Parse an integer the daemon sent as a decimal string. Anything else —
 * floats, words, empty — is refused instead of guessed at. */
function readBigInt(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    throw new ZKasSdkError(`${what} is not an integer amount`);
  }
  return BigInt(value.trim());
}

/**
 * Exact amounts for one prepared transaction. The `_exact` string fields are
 * the only ones trusted: the float `number` fields cannot represent large
 * sompi values precisely, so when an exact field is missing the float is only
 * accepted if it is a safe integer, and anything else is refused.
 */
function readExactAmounts(prepared: {
  amount_sompi_exact?: unknown;
  fee_sompi_exact?: unknown;
  remaining_sompi_exact?: unknown;
  remaining_sompi?: unknown;
  amount_sompi?: unknown;
  fee_sompi?: unknown;
}): { amount: bigint; fee: bigint; remaining: bigint } {
  const amount =
    prepared.amount_sompi_exact !== undefined
      ? readBigInt(prepared.amount_sompi_exact, "prover amount")
      : readSafeFloat(prepared.amount_sompi, "prover amount");
  const fee =
    prepared.fee_sompi_exact !== undefined
      ? readBigInt(prepared.fee_sompi_exact, "prover fee")
      : readSafeFloat(prepared.fee_sompi, "prover fee");
  const remaining =
    prepared.remaining_sompi_exact !== undefined
      ? readBigInt(prepared.remaining_sompi_exact, "prover remainder")
      : readSafeFloat(prepared.remaining_sompi ?? 0, "prover remainder");
  return { amount, fee, remaining };
}

function readSafeFloat(value: unknown, what: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ZKasSdkError(`${what} is not a precise amount`);
  }
  return BigInt(value);
}
