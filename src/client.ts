import { assertPaymentRequest, type PaymentSigner } from "./signer.js";
import { HOLD_WINDOW_MS, UNIFORM_FEE_V1, cryptoRandom, releaseTimes, uniformViolation } from "./uniform.js";
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
  UniformAnchorInfo,
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

export interface ZKasClientConfig {
  baseUrl: string;
  walletToken?: string;
  network: Network;
  fetch?: typeof globalThis.fetch;
  /** Clock and timers for uniform holds; injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform `[0, 1)` source for holds and release times (default: the platform CSPRNG). */
  random?: () => number;
}

export class ZKasClient {
  readonly #baseUrl: string;
  readonly #walletToken: string | undefined;
  readonly #network: Network;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(config: ZKasClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#walletToken = config.walletToken;
    this.#network = config.network;
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = config.now ?? (() => Date.now());
    this.#sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = config.random ?? cryptoRandom;
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
    if (request.uniform) return this.#sendUniform(signer, request, onStage);
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
      const prepared = await this.prepare(fvk, { ...request, amountSompi: owed }, chunking);
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
      const result = await this.submit(prepared.session, signatures);
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

    onStage?.("submitted");
    return { txid: parts[0]!.txid, txids: parts.map((p) => p.txid), parts, amountSompi: sent, feeSompi: fees };
  }

  async prepare(
    fvkHex: string,
    request: PaymentRequest,
    allowPartial = false,
    replaceSession?: string,
  ): Promise<PrepareResponse> {
    return this.#request<PrepareResponse>("POST", "/api/wallet/prepare", {
      fvk_hex: fvkHex,
      to: request.to.trim(),
      amount_sompi: request.amountSompi.toString(),
      ...(request.feeSompi === undefined || request.uniform ? {} : { fee: request.feeSompi.toString() }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      ...(allowPartial ? { allow_partial: true } : {}),
      ...(request.uniform ? { uniform: true } : {}),
      ...(replaceSession === undefined ? {} : { replace_session: replaceSession }),
    });
  }

  /** The anchor a uniform spend would use now (`GET /api/uniform/anchor`). */
  async uniformAnchor(): Promise<UniformAnchorInfo> {
    return this.#request<UniformAnchorInfo>("GET", "/api/uniform/anchor");
  }

  /**
   * Stage W send (spec 02 W5, W8, W11). The first sibling is prepared and signed at once (the
   * confirm), then held; every sibling goes out at its own independently drawn time inside
   * `max(hold, 4k²/λ̂)`. A held sibling whose anchor epoch rolled meanwhile is re-prepared and
   * re-signed before release. Each bundle is refused before signing unless it is the uniform
   * shape, whatever the daemon says.
   */
  async #sendUniform(
    signer: PaymentSigner,
    request: PaymentRequest,
    onStage?: (stage: SendStage, progress?: SendProgress) => void,
  ): Promise<SendResult> {
    const fvk = await signer.fullViewingKeyHex();
    const maxFee = maxFeeOf(request);
    if (UNIFORM_FEE_V1 > maxFee) {
      throw new ZKasSdkError(`a uniform transaction pays ${zkas(UNIFORM_FEE_V1)} ZKAS, above the approved maximum of ${zkas(maxFee)} ZKAS`);
    }
    const holdWindow = HOLD_WINDOW_MS[request.hold ?? "standard"];
    const confirmed = this.#now();
    const parts: SendPart[] = [];
    let sent = 0n;
    let fees = 0n;
    let owed = request.amountSompi;

    const prepareChecked = async (amount: bigint, replace?: string) => {
      const p = await this.prepare(fvk, { ...request, amountSompi: amount }, true, replace);
      const violation = uniformViolation(p.bundle_hex);
      if (violation !== null) throw new ZKasSdkError(`the daemon prepared a non-uniform transaction: ${violation}`);
      if (BigInt(p.fee_sompi_exact) !== UNIFORM_FEE_V1) throw new ZKasSdkError("the daemon reported a fee other than the uniform fee");
      const amt = BigInt(p.amount_sompi_exact);
      const rem = BigInt(p.remaining_sompi_exact ?? Math.trunc(p.remaining_sompi ?? 0));
      if (amt + rem !== amount) throw new ZKasSdkError("prover changed the requested amount");
      return p;
    };
    const sign = (p: PrepareResponse) =>
      signer.verifyAndSign({ network: this.#network, recipient: request.to.trim(), amountSompi: BigInt(p.amount_sompi_exact), maxFeeSompi: UNIFORM_FEE_V1, prepared: p });

    onStage?.("preparing", { part: 1, parts: 1, sentSompi: 0n, totalSompi: request.amountSompi });
    let prepared = await prepareChecked(owed);
    const k = Math.max(1, Math.min(8, prepared.uniform?.siblings ?? 1));
    const window = Math.max(holdWindow, prepared.uniform?.split_window_ms ?? 0);
    const times = releaseTimes(k, confirmed, confirmed + (k > 1 ? window : holdWindow), this.#random);
    onStage?.("signing", { part: 1, parts: k, sentSompi: 0n, totalSompi: request.amountSompi });
    let signatures: DeviceSignature[] | undefined = await sign(prepared);

    for (let i = 0; i < k && owed > 0n; i++) {
      const progress = (): SendProgress => ({ part: i + 1, parts: k, sentSompi: sent, totalSompi: request.amountSompi });
      const wait = times[i]! - this.#now();
      if (wait > 0) await this.#sleep(wait);
      if (i === 0) {
        // W5: re-anchor a held payment whose epoch rolled; never broadcast a stale-epoch spend.
        const anchor = await this.uniformAnchor().catch(() => undefined);
        if (anchor !== undefined && prepared.uniform !== undefined && anchor.anchor_blue !== prepared.uniform.anchor_blue) {
          onStage?.("preparing", progress());
          prepared = await prepareChecked(owed, prepared.session);
          signatures = await sign(prepared);
        }
      } else {
        onStage?.("preparing", progress());
        prepared = await prepareChecked(owed);
        onStage?.("signing", progress());
        signatures = await sign(prepared);
      }
      onStage?.("broadcasting", progress());
      const result = await this.submit(prepared.session, signatures!);
      parts.push({ txid: result.txid, amountSompi: BigInt(result.amount_sompi_exact), feeSompi: BigInt(result.fee_sompi_exact) });
      sent += BigInt(result.amount_sompi_exact);
      fees += BigInt(result.fee_sompi_exact);
      owed = BigInt(prepared.remaining_sompi_exact ?? Math.trunc(prepared.remaining_sompi ?? 0));
    }
    if (owed > 0n) {
      throw new ZKasSdkError(`sent ${zkas(sent)} ZKAS in ${parts.length} uniform transactions, but ${zkas(owed)} ZKAS remain unsent`);
    }
    onStage?.("submitted");
    return { txid: parts[0]!.txid, txids: parts.map((p) => p.txid), parts, amountSompi: sent, feeSompi: fees };
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
