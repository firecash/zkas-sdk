import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MAX_FEE_SOMPI, SubmitOutcomeUnknownError, ZKasClient, ZKasSdkError, maxFeeOf } from "./client.js";
import type { PaymentSigner } from "./signer.js";
import type { DeviceSignature, PrepareResponse, PreparedPaymentEnvelope } from "./types.js";

const RECIPIENT = "zkas:qqtestrecipient";

function envelope(amount: bigint, fee: bigint): PreparedPaymentEnvelope {
  return {
    format: "zkas-prepared-payment",
    version: 2,
    networkDomain: "aa".repeat(32),
    recipient: RECIPIENT,
    amount: amount.toString(),
    fee: fee.toString(),
    txContext: "0200",
    bundle: "00",
    disclosure: [],
    spendAuth: [],
    checksum: "",
  };
}

function prepareResponse(amount: bigint, fee: bigint, remaining: bigint): PrepareResponse {
  return {
    session: `session-${amount}`,
    amount_sompi: Number(amount),
    fee_sompi: Number(fee),
    amount_sompi_exact: amount.toString(),
    fee_sompi_exact: fee.toString(),
    remaining_sompi: Number(remaining),
    remaining_sompi_exact: remaining.toString(),
    bundle_hex: "00",
    disclosure: [],
    spend_auth: [],
    preparedPayment: envelope(amount, fee),
  };
}

/** A fake daemon: each /prepare consumes the next scripted chunk. */
function fakeDaemon(chunks: { amount: bigint; fee: bigint; remaining: bigint }[]) {
  const submitted: string[] = [];
  let next = 0;
  const fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const path = String(url);
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path.endsWith("/api/wallet/prepare")) {
      const chunk = chunks[next++];
      if (!chunk) return new Response(JSON.stringify({ error: "no more scripted chunks" }), { status: 500 });
      return respond(prepareResponse(chunk.amount, chunk.fee, chunk.remaining));
    }
    if (path.endsWith("/api/wallet/submit")) {
      const body = JSON.parse(String(init?.body)) as { session: string };
      submitted.push(body.session);
      const chunk = chunks[submitted.length - 1]!;
      return respond({
        txid: `tx-${submitted.length}`,
        amount_sompi: Number(chunk.amount),
        fee_sompi: Number(chunk.fee),
        amount_sompi_exact: chunk.amount.toString(),
        fee_sompi_exact: chunk.fee.toString(),
      });
    }
    return new Response(JSON.stringify({ error: `unexpected ${path}` }), { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, submitted };
}

function signerStub(log: { maxFees: bigint[] }): PaymentSigner {
  return {
    fullViewingKeyHex: async () => "ff".repeat(96),
    verifyAndSign: async ({ maxFeeSompi }) => {
      log.maxFees.push(maxFeeSompi);
      return [{ index: 0, sig: "aa".repeat(64) }] satisfies DeviceSignature[];
    },
  };
}

function client(fetch: typeof globalThis.fetch): ZKasClient {
  return new ZKasClient({ baseUrl: "http://daemon", network: "mainnet", fetch });
}

test("single-transaction send verifies with the default fee ceiling", async () => {
  const daemon = fakeDaemon([{ amount: 5_000_000_000n, fee: 3_000_000n, remaining: 0n }]);
  const log = { maxFees: [] as bigint[] };
  const result = await client(daemon.fetch).send(signerStub(log), { to: RECIPIENT, amountSompi: 5_000_000_000n });
  assert.equal(result.txids.length, 1);
  assert.equal(result.amountSompi, 5_000_000_000n);
  assert.equal(result.feeSompi, 3_000_000n);
  assert.deepEqual(log.maxFees, [DEFAULT_MAX_FEE_SOMPI]);
});

test("a fragmented wallet pays across chunks until nothing remains", async () => {
  const daemon = fakeDaemon([
    { amount: 6_000_000_000n, fee: 4_400_000n, remaining: 4_000_000_000n },
    { amount: 4_000_000_000n, fee: 3_000_000n, remaining: 0n },
  ]);
  const log = { maxFees: [] as bigint[] };
  const result = await client(daemon.fetch).send(signerStub(log), { to: RECIPIENT, amountSompi: 10_000_000_000n });
  assert.deepEqual(result.txids, ["tx-1", "tx-2"]);
  assert.equal(result.amountSompi, 10_000_000_000n);
  assert.equal(result.feeSompi, 7_400_000n);
  assert.equal(daemon.submitted.length, 2);
});

test("a fee above the approved maximum is refused before signing", async () => {
  // The daemon claims the entire remainder of the wallet as "fee".
  const daemon = fakeDaemon([{ amount: 1_000_000_000n, fee: 42_000_000_000n, remaining: 0n }]);
  const log = { maxFees: [] as bigint[] };
  await assert.rejects(
    client(daemon.fetch).send(signerStub(log), { to: RECIPIENT, amountSompi: 1_000_000_000n }),
    (error: unknown) => error instanceof ZKasSdkError && /above the approved maximum/.test(error.message),
  );
  assert.equal(log.maxFees.length, 0, "the signer must never see an over-fee payment");
  assert.equal(daemon.submitted.length, 0);
});

test("a prover that changes the requested amount is refused", async () => {
  // amount + remaining ≠ requested: the daemon is paying less while claiming completion.
  const daemon = fakeDaemon([{ amount: 900_000_000n, fee: 3_000_000n, remaining: 0n }]);
  await assert.rejects(
    client(daemon.fetch).send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 1_000_000_000n }),
    (error: unknown) => error instanceof ZKasSdkError && /changed the requested amount/.test(error.message),
  );
});

test("the ceiling never sits below the caller's own fee floor", () => {
  assert.equal(maxFeeOf({ to: RECIPIENT, amountSompi: 1n }), DEFAULT_MAX_FEE_SOMPI);
  assert.equal(maxFeeOf({ to: RECIPIENT, amountSompi: 1n, feeSompi: 20_000_000n }), 20_000_000n);
  assert.equal(maxFeeOf({ to: RECIPIENT, amountSompi: 1n, maxFeeSompi: 5_000_000n }), 5_000_000n);
});

/** A daemon scripted per call, recording every prepare body. */
function scriptedDaemon(prepares: (Response | (() => Response))[], submits: (Response | (() => Response))[]) {
  const prepareBodies: Record<string, unknown>[] = [];
  let p = 0;
  let s = 0;
  const fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const path = String(url);
    if (path.endsWith("/api/wallet/prepare")) {
      prepareBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const r = prepares[p++];
      return typeof r === "function" ? r() : r!;
    }
    if (path.endsWith("/api/wallet/submit")) {
      const r = submits[s++];
      return typeof r === "function" ? r() : r!;
    }
    return new Response(JSON.stringify({ error: `unexpected ${path}` }), { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, prepareBodies };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const submitted = (txid: string, amount: bigint, fee: bigint) =>
  json({ txid, amount_sompi: Number(amount), fee_sompi: Number(fee), amount_sompi_exact: amount.toString(), fee_sompi_exact: fee.toString() });

test("a requestId is sent with every part, suffixed for the later ones", async () => {
  const d = scriptedDaemon(
    [json(prepareResponse(300n, 10n, 200n)), json(prepareResponse(200n, 10n, 0n))],
    [submitted("tx-1", 300n, 10n), submitted("tx-2", 200n, 10n)],
  );
  const client = new ZKasClient({ baseUrl: "http://wallet", network: "mainnet", fetch: d.fetch });
  const r = await client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n, requestId: "withdrawal-88213" });
  assert.deepEqual(r.txids, ["tx-1", "tx-2"]);
  assert.deepEqual(d.prepareBodies.map((b) => b.request_id), ["withdrawal-88213", "withdrawal-88213.1"]);
});

test("a retry records what was already sent and pays only the rest", async () => {
  const d = scriptedDaemon(
    [
      json({ error: "this payment was already sent", already_sent: { txid: "tx-1", amount_sompi_exact: "300", fee_sompi_exact: "10" } }, 409),
      json(prepareResponse(200n, 10n, 0n)),
    ],
    [submitted("tx-2", 200n, 10n)],
  );
  const client = new ZKasClient({ baseUrl: "http://wallet", network: "mainnet", fetch: d.fetch });
  const r = await client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n, requestId: "withdrawal-1" });
  assert.deepEqual(r.txids, ["tx-1", "tx-2"]);
  assert.equal(r.amountSompi, 500n);
  assert.equal(d.prepareBodies[1]!.amount_sompi, "200", "only the remainder is prepared");
});

test("a fresh payment never accepts an 'already sent' claim", async () => {
  const d = scriptedDaemon([json({ error: "already sent", already_sent: { txid: "made-up", amount_sompi_exact: "500" } }, 409)], []);
  const client = new ZKasClient({ baseUrl: "http://wallet", network: "mainnet", fetch: d.fetch });
  await assert.rejects(client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n }), (e) => !(e instanceof SubmitOutcomeUnknownError));
});

test("an unknown broadcast outcome is reported as such, never as a failure", async () => {
  for (const submitReply of [
    () => json({ error: "not known whether it went out", outcome_unknown: true, txid: "tx-u" }, 504),
    () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const d = scriptedDaemon([json(prepareResponse(500n, 10n, 0n))], [submitReply]);
    const client = new ZKasClient({ baseUrl: "http://wallet", network: "mainnet", fetch: d.fetch });
    const e = await client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n, requestId: "w-2" }).catch((x) => x);
    assert.ok(e instanceof SubmitOutcomeUnknownError, `unknown outcome, got ${String(e)}`);
  }
  // The service answering with a refusal is a real failure.
  const d = scriptedDaemon([json(prepareResponse(500n, 10n, 0n))], [json({ error: "The node would not accept this payment" }, 502)]);
  const client = new ZKasClient({ baseUrl: "http://wallet", network: "mainnet", fetch: d.fetch });
  const e = await client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n, requestId: "w-3" }).catch((x) => x);
  assert.ok(e instanceof ZKasSdkError && !(e instanceof SubmitOutcomeUnknownError));
});

test("an unusable requestId is refused before anything is sent", async () => {
  const client = new ZKasClient({ baseUrl: "http://wallet", network: "mainnet", fetch: scriptedDaemon([], []).fetch });
  await assert.rejects(client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n, requestId: " " }), RangeError);
  await assert.rejects(client.send(signerStub({ maxFees: [] }), { to: RECIPIENT, amountSompi: 500n, requestId: "x".repeat(121) }), RangeError);
});

test("the deposit journal is paged by sequence number and a request's fate is asked by its id", async () => {
  const seen: string[] = [];
  const fetch = (async (url: unknown) => {
    const path = String(url);
    seen.push(path);
    if (path.includes("/api/wallet/deposits")) {
      return new Response(JSON.stringify({ events: [{ seq: 8, kind: "credit", txid: "ab", i: 0, amountSompiExact: "5" }], last_seq: 8, after: 7 }), { status: 200 });
    }
    if (path.includes("/api/wallet/requests/")) {
      return new Response(JSON.stringify({ request_id: "w/1", state: "sent", transactions: [{ txid: "ab", state: "landed", depth: 3 }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const client = new ZKasClient({ baseUrl: "http://daemon", network: "mainnet", fetch });
  const page = await client.deposits(7, 10);
  assert.equal(page.last_seq, 8);
  assert.equal(page.events[0]?.seq, 8);
  assert.ok(seen[0]?.endsWith("/api/wallet/deposits?after=7&limit=10"));
  const r = await client.requestStatus("w/1");
  assert.equal(r.transactions?.[0]?.state, "landed");
  assert.ok(seen[1]?.endsWith("/api/wallet/requests/w%2F1"), "the id is URL-encoded");
});
