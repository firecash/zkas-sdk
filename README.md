# ZKas SDK

Build on ZKas — the shielded-by-default Kaspa fork — without reimplementing any
cryptography. This repository is the developer-facing home of the SDK:

- **`@zkas/sdk`** (this package): typed TypeScript client for hosted
  non-custodial wallets — status, watch-only registration, balance, history,
  and the full verified send flow (prepare → verify on-device → sign → submit),
  with automatic multi-transaction chunking and progress events.
- **Rust crates** (`zkas-sdk`, `zkas-signer`, `zkas-wallet-engine`): the
  canonical implementation, developed inside the node workspace at
  [`firecash-rusty/sdk`](https://github.com/firecash/firecash-rusty/tree/master/sdk)
  so the wallet daemon and the SDK can never drift apart. Depend on them as git
  dependencies.
- **`docs/`**: architecture, integration/security guide, and honest status.

## Trust model, stated plainly

| Mode | Keys | Who scans/proves | What you get |
|---|---|---|---|
| Hosted hybrid (this package) | Seed on device; FVK at the service | Service | Non-custodial spending: the service can see wallet activity but can never move funds or trick the device into signing a payment it didn't intend |
| Local/native (Rust crates) | All local | Local | Fully private from the wallet service |
| Watch-only | FVK only | Either | View and reconcile; cannot spend |

Two properties are enforced by the signer, not by policy documents:

1. **No blind signing.** The device reconstructs the bundle, checks every note
   and value commitment against the prover's disclosure, confirms the payment
   pays exactly the approved recipient and amount (everything else change back
   to the wallet), and signs a sighash it recomputed itself.
2. **Fee ceiling.** The fee is read from the bundle's own public value balance —
   never from a figure the server reports — and the signer refuses anything
   above the user's approved maximum (`DEFAULT_MAX_FEE_SOMPI` = 0.1 ZKAS unless
   raised). A compromised daemon cannot burn your change as "fee".

## Install

```bash
npm install @zkas/sdk        # or depend on this repo directly
```

## Send a payment (hosted, non-custodial)

```ts
import { ZKasClient, wasmPaymentSigner, DEFAULT_MAX_FEE_SOMPI } from "@zkas/sdk";
// The WASM signer ships with the wallet; build it from
// https://github.com/firecash/firecash-signer (wasm-bindgen, no proving circuit).
import { fvkHex, verifyAndSignPayment } from "./firecash-signer";

const client = new ZKasClient({
  baseUrl: "https://wallet.zkas.info/daemon",
  walletToken: myToken,          // capability token selecting the wallet
  network: "mainnet",
});

const signer = wasmPaymentSigner({ seedHex, fvkHex, verifyAndSignPayment });

const result = await client.send(signer, {
  to: "zkas:…",
  amountSompi: 150_000_000_000n,       // exact integers only — never floats
  maxFeeSompi: DEFAULT_MAX_FEE_SOMPI,  // per-transaction ceiling the device enforces
}, (stage, p) => console.log(stage, p));

console.log(result.txids, result.feeSompi);
```

A fragmented wallet (many small notes) is paid across several standard
transactions automatically; each chunk is independently verified and signed,
and the loop holds the daemon to the exact requested total.

## Watch-only & state

```ts
await client.watch(fvkHex, birthdayDaa);  // register: viewing key only, never a seed
const status = await client.status();
if (status.missing_history) {
  // The node serving this wallet has pruned part of its history: the balance
  // is a LOWER BOUND. Show it. Do not rescan through this node.
}
```

## Development

```bash
npm install
npm test        # tsc + node --test against a scripted fake daemon
```

The wire format (`PreparedPaymentEnvelope`, version 2) is pinned by a golden
vector test on the Rust side; the TypeScript types in `src/types.ts` mirror it
field for field.

## License

ISC
