/**
 * Stage W of uniform transactions (ZKas spec 02) on the client side.
 *
 * The SDK builds no transaction bytes: walletd plans, proves and assembles them with the shared
 * Rust wallet engine. What the SDK owns is the device's part of a uniform payment:
 *
 * - refuse to sign anything that is not the uniform shape (4 actions, fee exactly
 *   {@link UNIFORM_FEE_V1}, flags 0x0b, anchor block named) — {@link uniformViolation};
 * - hold the signed payment `U[0, W]` before broadcast (W11) and draw the release times of a
 *   split payment's siblings independently (W8) — {@link releaseTimes}.
 *
 * The constants mirror `zkas_wallet_engine::uniform`; `uniform.test.ts` checks them and the
 * envelope parser against the golden vectors the Rust builders are tested against
 * (`test/vectors/uniform-v1.json`, copied from zkas-rusty `sdk/wallet-engine/tests/vectors/`).
 */

export const UNIFORM_ACTIONS = 4;
export const UNIFORM_FEE_V1 = 3_117_800n;
export const UNIFORM_FLAGS_V1 = 0x0b;
export const UNIFORM_PAYLOAD_LEN_V1 = 15_493;
const FLAG_BURN = 0x04;
const FLAG_ANCHOR_BLOCK = 0x08;
const ACTION_LEN = 884;

/** Interactive hold modes (W11). */
export type HoldMode = "immediate" | "standard" | "private";

export const HOLD_WINDOW_MS: Readonly<Record<HoldMode, number>> = {
  immediate: 0,
  standard: 120_000,
  private: 1_800_000,
};

/** The public header fields of a serialized shielded bundle. */
export interface BundleEnvelope {
  flags: number;
  valueBalance: bigint;
  actions: number;
  byteLength: number;
  anchorBlock: boolean;
  burn: boolean;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new TypeError("bundle is not hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Read the envelope of a serialized bundle (`kaspa_shielded_core::bundle::ShieldedBundle::to_bytes`:
 * flags u8, value_balance i64 BE, anchor 32, binding_sig u32-BE-prefixed, action count u32 BE,
 * actions, proof u32-BE-prefixed, optional burn 40, optional anchor block 32).
 */
export function parseBundleEnvelope(hex: string): BundleEnvelope {
  const b = hexToBytes(hex);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (at + n > b.length) throw new RangeError("bundle is truncated");
  };
  need(1 + 8 + 32 + 4);
  const flags = b[0]!;
  const valueBalance = view.getBigInt64(1, false);
  at = 1 + 8 + 32;
  const sigLen = view.getUint32(at, false);
  at += 4;
  need(sigLen + 4);
  at += sigLen;
  const actions = view.getUint32(at, false);
  at += 4;
  need(actions * ACTION_LEN + 4);
  at += actions * ACTION_LEN;
  const proofLen = view.getUint32(at, false);
  at += 4;
  need(proofLen);
  at += proofLen;
  const burn = (flags & FLAG_BURN) !== 0;
  if (burn) {
    need(40);
    at += 40;
  }
  const anchorBlock = (flags & FLAG_ANCHOR_BLOCK) !== 0;
  if (anchorBlock) {
    need(32);
    at += 32;
  }
  if (at !== b.length) throw new RangeError("bundle has trailing bytes");
  return { flags, valueBalance, actions, byteLength: b.length, anchorBlock, burn };
}

/**
 * Why a bundle is not a V1 uniform transaction, or `null` if it is. `final` also pins the byte
 * length, which only a proven bundle has (a prepared, unsigned bundle carries no proof).
 */
export function uniformViolation(hex: string, final = false): string | null {
  let e: BundleEnvelope;
  try {
    e = parseBundleEnvelope(hex);
  } catch (err) {
    return `not a shielded bundle: ${(err as Error).message}`;
  }
  if (e.actions !== UNIFORM_ACTIONS) return `bundle has ${e.actions} actions, a uniform transaction has ${UNIFORM_ACTIONS}`;
  if (e.burn) return "bundle carries a burn declaration";
  if (!e.anchorBlock) return "bundle does not name its anchor block";
  if (e.flags !== UNIFORM_FLAGS_V1) return `bundle flags are 0x${e.flags.toString(16)}, a uniform transaction has 0x0b`;
  if (e.valueBalance !== UNIFORM_FEE_V1) return `bundle pays a fee of ${e.valueBalance} sompi, a uniform transaction pays exactly ${UNIFORM_FEE_V1}`;
  if (final && e.byteLength !== UNIFORM_PAYLOAD_LEN_V1) return `payload is ${e.byteLength} bytes, a uniform transaction is ${UNIFORM_PAYLOAD_LEN_V1}`;
  return null;
}

/** A uniform draw in `[0, 1)` from the platform CSPRNG. */
export function cryptoRandom(): number {
  const a = new Uint32Array(2);
  globalThis.crypto.getRandomValues(a);
  // 53 random bits.
  return ((a[0]! >>> 5) * 67108864 + (a[1]! >>> 6)) / 9007199254740992;
}

/**
 * i.i.d. `Uniform(start, end)` release times for `n` transactions, sorted (spec 02 W13). No
 * transaction is released because a timer ticked.
 */
export function releaseTimes(n: number, startMs: number, endMs: number, random: () => number = cryptoRandom): number[] {
  const span = Math.max(0, endMs - startMs);
  return Array.from({ length: n }, () => startMs + Math.floor(random() * (span + 1))).sort((a, b) => a - b);
}
