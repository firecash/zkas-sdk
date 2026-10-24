import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ZKasClient, ZKasSdkError } from "./client.js";
import type { PaymentSigner } from "./signer.js";
import type { PrepareResponse } from "./types.js";
import {
  UNIFORM_ACTIONS,
  UNIFORM_FEE_V1,
  UNIFORM_FLAGS_V1,
  UNIFORM_PAYLOAD_LEN_V1,
  parseBundleEnvelope,
  releaseTimes,
  uniformViolation,
} from "./uniform.js";

/** The golden vectors the Rust builders (engine/shielded-core and walletd) are tested against. */
const golden = JSON.parse(readFileSync(new URL("../test/vectors/uniform-v1.json", import.meta.url), "utf8")) as {
  fee: number;
  flags: number;
  actions: number;
  payload_len: number;
  vectors: { name: string; len: number; sha256: string; payload_hex?: string }[];
};
const payloadHex = golden.vectors.find((v) => v.name === "pay-1-note")!.payload_hex!;

function patched(hex: string, byteIndex: number, value: number): string {
  return hex.slice(0, 2 * byteIndex) + value.toString(16).padStart(2, "0") + hex.slice(2 * byteIndex + 2);
}

test("SDK constants agree with the Rust golden vectors", () => {
  assert.equal(BigInt(golden.fee), UNIFORM_FEE_V1);
  assert.equal(golden.flags, UNIFORM_FLAGS_V1);
  assert.equal(golden.actions, UNIFORM_ACTIONS);
  assert.equal(golden.payload_len, UNIFORM_PAYLOAD_LEN_V1);
  for (const v of golden.vectors) assert.equal(v.len, UNIFORM_PAYLOAD_LEN_V1, v.name);
});

test("the envelope parser reads the Rust-built uniform payload byte for byte", async () => {
  const e = parseBundleEnvelope(payloadHex);
  assert.equal(e.actions, 4);
  assert.equal(e.flags, 0x0b);
  assert.equal(e.valueBalance, UNIFORM_FEE_V1);
  assert.equal(e.byteLength, UNIFORM_PAYLOAD_LEN_V1);
  assert.ok(e.anchorBlock && !e.burn);
  assert.equal(uniformViolation(payloadHex, true), null);
  // The same bytes hash to the golden SHA-256: the SDK sees exactly what the builders emit.
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(payloadHex, "hex"))).toString("hex");
  assert.equal(digest, golden.vectors.find((v) => v.name === "pay-1-note")!.sha256);
});

test("every single-field deviation is refused", () => {
  // Flipping a flag bit also changes which trailing fields the layout has, so the parser may
  // refuse on length before the flag check; either way the bundle is refused.
  assert.match(uniformViolation(patched(payloadHex, 0, 0x03))!, /flags|anchor block|trailing/);
  assert.match(uniformViolation(patched(payloadHex, 0, 0x0f))!, /burn|truncated/);
  assert.match(uniformViolation(patched(payloadHex, 8, 0x01))!, /fee/);
  assert.match(uniformViolation(payloadHex.slice(0, -2))!, /truncated|trailing|not a shielded/);
  assert.match(uniformViolation(payloadHex + "00")!, /trailing/);
  // Action count 2 (byte 112..116 is the u32 BE count after flags 1 + vb 8 + anchor 32 + sig 4+64).
  assert.match(uniformViolation(patched(payloadHex, 112, 2))!, /truncated|actions|trailing/);
});

test("release times are i.i.d. inside the window and sorted", () => {
  let x = 0.123;
  const rnd = () => (x = (x * 9301 + 0.49297) % 1);
  const t = releaseTimes(1000, 1000, 121_000, rnd);
  assert.equal(t.length, 1000);
  assert.ok(t.every((v, i) => v >= 1000 && v <= 121_000 && (i === 0 || t[i - 1]! <= v)));
});

function uniformPrepare(amount: bigint, remaining: bigint, session: string, anchorBlue: number, siblings: number, bundle = payloadHex): PrepareResponse {
  return {
    session,
    amount_sompi: Number(amount),
    fee_sompi: Number(UNIFORM_FEE_V1),
    amount_sompi_exact: amount.toString(),
    fee_sompi_exact: UNIFORM_FEE_V1.toString(),
    remaining_sompi: Number(remaining),
    remaining_sompi_exact: remaining.toString(),
    bundle_hex: bundle,
    disclosure: [],
    spend_auth: [],
    preparedPayment: {
      format: "zkas-prepared-payment",
      version: 2,
      networkDomain: "aa".repeat(32),
      recipient: "zkas:q",
      amount: amount.toString(),
      fee: UNIFORM_FEE_V1.toString(),
      txContext: "",
      bundle: "",
      disclosure: [],
      spendAuth: [],
      checksum: "",
    },
    uniform: {
      anchor_blue: anchorBlue,
      anchor_epoch: Math.floor(anchorBlue / 120),
      valid_until_blue: 0,
      sink_blue: 0,
      lambda_per_s: 0.256,
      siblings,
      split_window_ms: siblings > 1 ? 250_000 : 0,
      fee_sompi: Number(UNIFORM_FEE_V1),
    },
  };
}

function harness(opts: { prepares: PrepareResponse[]; anchorBlue: number }) {
  const bodies: Record<string, unknown>[] = [];
  const submitted: string[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  let i = 0;
  const fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const path = String(url);
    const respond = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path.endsWith("/api/wallet/prepare")) {
      bodies.push(JSON.parse(String(init?.body)));
      return respond(opts.prepares[i++]);
    }
    if (path.endsWith("/api/uniform/anchor")) return respond({ anchor_blue: opts.anchorBlue });
    if (path.endsWith("/api/wallet/submit")) {
      const b = JSON.parse(String(init?.body)) as { session: string };
      submitted.push(b.session);
      const p = opts.prepares.find((x) => x.session === b.session)!;
      return respond({ txid: `tx-${b.session}`, amount_sompi: p.amount_sompi, amount_sompi_exact: p.amount_sompi_exact, fee_sompi: p.fee_sompi, fee_sompi_exact: p.fee_sompi_exact });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  let signed = 0;
  const signer: PaymentSigner = {
    fullViewingKeyHex: async () => "ff".repeat(96),
    verifyAndSign: async () => {
      signed++;
      return [];
    },
  };
  const client = new ZKasClient({
    baseUrl: "http://d",
    network: "mainnet",
    fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0.5,
  });
  return { client, signer, bodies, submitted, sleeps, signedCount: () => signed };
}

test("a uniform send prepares with uniform: true, holds, then broadcasts", async () => {
  const h = harness({ prepares: [uniformPrepare(100n, 0n, "s1", 9_360, 1)], anchorBlue: 9_360 });
  const r = await h.client.send(h.signer, { to: "zkas:q", amountSompi: 100n, uniform: true });
  assert.equal(h.bodies[0]!.uniform, true);
  assert.equal(h.bodies[0]!.allow_partial, true);
  assert.equal(h.bodies[0]!.fee, undefined, "a uniform send never asks for a fee: it is exact");
  assert.deepEqual(h.sleeps, [60_000], "U[0,120 s] hold at random() = 0.5");
  assert.deepEqual(h.submitted, ["s1"]);
  assert.equal(r.feeSompi, UNIFORM_FEE_V1);
});

test("a held payment whose anchor epoch rolled is re-prepared and re-signed", async () => {
  const h = harness({ prepares: [uniformPrepare(100n, 0n, "s1", 9_360, 1), uniformPrepare(100n, 0n, "s2", 9_480, 1)], anchorBlue: 9_480 });
  await h.client.send(h.signer, { to: "zkas:q", amountSompi: 100n, uniform: true });
  assert.equal(h.bodies[1]!.replace_session, "s1", "the stale session's notes are released");
  assert.deepEqual(h.submitted, ["s2"], "only the re-anchored transaction goes out");
  assert.equal(h.signedCount(), 2);
});

test("siblings go out at independent times over the split window", async () => {
  const h = harness({
    prepares: [uniformPrepare(60n, 40n, "a", 9_360, 2), uniformPrepare(40n, 0n, "b", 9_360, 2)],
    anchorBlue: 9_360,
  });
  const r = await h.client.send(h.signer, { to: "zkas:q", amountSompi: 100n, uniform: true });
  assert.deepEqual(h.submitted, ["a", "b"]);
  assert.equal(r.amountSompi, 100n);
  // Both releases fall inside max(120 s, 250 s) of the confirm; with random() = 0.5 both draw 125 s.
  assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 125_000);
});

test("a non-uniform bundle is refused before anything is signed", async () => {
  const bad = uniformPrepare(100n, 0n, "s1", 9_360, 1, patched(payloadHex, 0, 0x03));
  const h = harness({ prepares: [bad], anchorBlue: 9_360 });
  await assert.rejects(h.client.send(h.signer, { to: "zkas:q", amountSompi: 100n, uniform: true }), ZKasSdkError);
  assert.equal(h.signedCount(), 0);
  assert.deepEqual(h.submitted, []);
});
