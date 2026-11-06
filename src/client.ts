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
  DepositPage,
  RequestStatus,
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

/**
 * The wallet service could not tell whether a payment's broadcast went out — its
 * connection to the node failed mid-broadcast (HTTP 504 `outcome_unknown`), or the
 * connection to the service itself failed while it was broadcasting. The payment may
 * have been sent. Never treat this as a failure: retry the SAME payment with the SAME
 * `requestId`, and the service answers with what it already sent instead of paying again.
 * `parts` lists the transactions of this payment already confirmed sent; `txid`, when
 * known, is the transaction whose outcome is unknown.
 */
export class SubmitOutcomeUnknownError extends ZKasSdkError {
  constructor(
    message: string,
    readonly txid: string | undefined,
    readonly parts: SendPart[],
    status?: number,
    body?: unknown,
  ) {
    super(message, status, body);
    this.name = "SubmitOutcomeUnknownError";
  }
}

/** The wallet service's "this payment was already sent" answer (HTTP 409), if `e` is one. */
export function alreadySentOf(e: unknown): { txid: string; amount_sompi_exact?: string; amount_sompi?: number; fee_sompi_exact?: string; fee_sompi?: number } | undefined {
  if (!(e instanceof ZKasSdkError) || e.status !== 409) return undefined;
  const sent = (e.body as { already_sent?: unknown } | undefined)?.already_sent;
  return typeof sent === "object" && sent !== null && typeof (sent as { txid?: unknown }).txid === "string"
    ? (sent as { txid: string })
    : undefined;
}

/** The request id of part `chunk` of a payment (the service's own convention). */
function partRequestId(requestId: string | undefined, chunk: number): string | undefined {
  if (requestId === undefined) return undefined;
  return chunk === 0 ? requestId.trim() : `${requestId.trim()}.${chunk}`;
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
   * The deposit journal, oldest first, after sequence number `after` (0 = from the start): the
   * way to credit deposits. Nothing is skipped however long the caller was away, nothing is
   * returned twice; store the last `seq` processed. See `DepositEvent`.
   */
  async deposits(after = 0, limit = 500): Promise<DepositPage> {
    return this.#request<DepositPage>("GET", `/api/wallet/deposits?after=${Math.max(0, Math.floor(after))}&limit=${Math.max(1, Math.floor(limit))}`);
  }

  /**
   * What became of a payment sent with `requestId`, for a caller that lost the answer. 404
   * (`ZKasSdkError` with status 404) when the daemon has no record of it for this wallet.
   */
  async requestStatus(requestId: string): Promise<RequestStatus> {
    return this.#request<RequestStatus>("GET", `/api/wallet/requests/${encodeURIComponent(requestId)}`);
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
    const fvk = await signer.fullViewingKeyHex();
    const maxFee = maxFeeOf(request);
    const chunking = request.allowChunking !== false;

    const parts: SendPart[] = [];
    let sent = 0n;
    let fees = 0n;
    let owed = request.amountSompi;
    let estimated = 1;

    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const progress = (): SendProgress => ({
        part: chunk + 1,
        parts: Math.max(estimated, chunk + 1),
        sentSompi: sent,
        totalSompi: request.amountSompi,
      });

      onStage?.("preparing", progress());
      const requestId = partRequestId(request.requestId, chunk);
      let prepared: PrepareResponse;
      try {
        prepared = await this.prepare(fvk, { ...request, amountSompi: owed, ...(requestId === undefined ? {} : { requestId }) }, chunking);
      } catch (e) {
        // A retry of a payment the service already broadcast (same requestId): record that
        // transaction as this part instead of paying it again. Only for a caller-supplied id
        // — a service cannot claim a fresh payment was "already sent" — and never for more
        // than this part still owes.
        const done = request.requestId === undefined ? undefined : alreadySentOf(e);
        if (!done) throw e;
        const paid = BigInt(done.amount_sompi_exact ?? Math.trunc(done.amount_sompi ?? 0));
        const paidFee = BigInt(done.fee_sompi_exact ?? Math.trunc(done.fee_sompi ?? 0));
        if (paid <= 0n || paid > owed || paidFee < 0n) throw new ZKasSdkError("the service's record of this payment does not match the request");
        parts.push({ txid: done.txid, amountSompi: paid, feeSompi: paidFee });
        sent += paid;
        fees += paidFee;
        owed -= paid;
        if (owed <= 0n) break;
        if (chunk === MAX_CHUNKS - 1) {
          throw new ZKasSdkError(`sent ${zkas(sent)} ZKAS in ${parts.length} transactions, but ${zkas(owed)} ZKAS could not be sent`);
        }
        continue;
      }
      const amount = BigInt(prepared.amount_sompi_exact);
      const fee = BigInt(prepared.fee_sompi_exact);
      const remaining = BigInt(prepared.remaining_sompi_exact ?? Math.trunc(prepared.remaining_sompi ?? 0));
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
        recipient: request.to.trim(),
        amountSompi: amount,
        maxFeeSompi: maxFee,
        prepared,
      });

      onStage?.("broadcasting", progress());
      let result: SubmitResponse;
      try {
        result = await this.submit(prepared.session, signatures);
      } catch (e) {
        // No answer, the service saying it cannot tell (504 outcome_unknown), or a reply that
        // is not the service's (a proxy's error page): the transaction may be on the network.
        const unknown =
          !(e instanceof ZKasSdkError) ||
          (e.status === 504 && (e.body as { outcome_unknown?: unknown } | undefined)?.outcome_unknown === true) ||
          ((e.status ?? 0) >= 500 && e.body === undefined);
        if (!unknown) throw e;
        const txid = e instanceof ZKasSdkError ? (e.body as { txid?: string } | undefined)?.txid : undefined;
        throw new SubmitOutcomeUnknownError(
          `it is not known whether this payment's transaction went out${txid ? ` (${txid})` : ""}; ` +
            (request.requestId === undefined
              ? "check the wallet's history before paying again — without a requestId a retry cannot be matched to it"
              : "retry with the same requestId: an already-sent payment is answered, never paid twice"),
          txid,
          [...parts],
          e instanceof ZKasSdkError ? e.status : undefined,
          e instanceof ZKasSdkError ? e.body : undefined,
        );
      }
      parts.push({ txid: result.txid, amountSompi: BigInt(result.amount_sompi_exact), feeSompi: BigInt(result.fee_sompi_exact) });
      sent += BigInt(result.amount_sompi_exact);
      fees += BigInt(result.fee_sompi_exact);

      if (remaining <= 0n) break;
      owed = remaining;
      if (chunk === MAX_CHUNKS - 1) {
        throw new ZKasSdkError(
          `sent ${zkas(sent)} ZKAS in ${parts.length} transactions, but ${zkas(owed)} ZKAS could not be sent: ` +
            `the wallet's balance is split across too many small notes. Consolidate and send the rest.`,
        );
      }
    }

    if (parts.length === 0) throw new ZKasSdkError("nothing was sent");
    onStage?.("submitted");
    return { txid: parts[0]!.txid, txids: parts.map((p) => p.txid), parts, amountSompi: sent, feeSompi: fees };
  }

  async prepare(fvkHex: string, request: PaymentRequest, allowPartial = false): Promise<PrepareResponse> {
    return this.#request<PrepareResponse>("POST", "/api/wallet/prepare", {
      fvk_hex: fvkHex,
      to: request.to.trim(),
      amount_sompi: request.amountSompi.toString(),
      ...(request.feeSompi === undefined ? {} : { fee: request.feeSompi.toString() }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      ...(allowPartial ? { allow_partial: true } : {}),
      ...(request.requestId === undefined ? {} : { request_id: request.requestId }),
    });
  }

  async submit(session: string, signatures: DeviceSignature[]): Promise<SubmitResponse> {
    return this.#request<SubmitResponse>("POST", "/api/wallet/submit", { session, sigs: signatures });
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
