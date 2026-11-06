export type Network = "mainnet" | "testnet" | "devnet" | "simnet";

export interface DisclosureV1 {
  spendValue: string;
  outValue: string;
  outRecipient: string;
  outRseed: string;
  rcv: string;
}

export interface SpendAuthV1 {
  actionIndex: number;
  alpha: string;
}

/**
 * Versioned prepared-payment envelope (see `zkas-sdk`'s `PreparedPaymentEnvelope`).
 * Version 2 embeds the prover's CLAIMED intent — recipient, amount, fee — so a
 * detached signer can display the payment from the envelope alone. Claims are
 * display data: the signer cross-checks them against the user's approval and
 * against the bundle itself, and reads the real fee from the bundle's value
 * balance, never from these fields.
 */
export interface PreparedPaymentEnvelope {
  format: "zkas-prepared-payment";
  version: 2;
  networkDomain: string;
  recipient: string;
  amount: string;
  fee: string;
  txContext: string;
  bundle: string;
  disclosure: DisclosureV1[];
  spendAuth: SpendAuthV1[];
  checksum: string;
}

export interface LegacyDisclosure {
  spend_value: number;
  out_value: number;
  out_recipient: string;
  out_rseed: string;
  rcv: string;
}

export interface LegacySpendAuth {
  index: number;
  alpha: string;
}

export interface PrepareResponse {
  session: string;
  amount_sompi: number;
  fee_sompi: number;
  amount_sompi_exact: string;
  fee_sompi_exact: string;
  /** Sompi of the request this transaction does NOT cover; only non-zero when
   * `allow_partial` was sent. Older daemons omit the exact form. */
  remaining_sompi?: number;
  remaining_sompi_exact?: string;
  bundle_hex: string;
  disclosure: LegacyDisclosure[];
  spend_auth: LegacySpendAuth[];
  preparedPayment: PreparedPaymentEnvelope;
}

export interface DeviceSignature {
  index: number;
  sig: string;
}

export interface SubmitResponse {
  txid: string;
  amount_sompi: number;
  fee_sompi: number;
  amount_sompi_exact: string;
  fee_sompi_exact: string;
}

export interface PaymentRequest {
  to: string;
  /** Exact integer amount. Never pass a floating-point coin amount. */
  amountSompi: bigint;
  /** Fee FLOOR the daemon may raise to the byte-priced relay minimum. */
  feeSompi?: bigint;
  /**
   * Largest per-transaction fee the local signer will authorize, in sompi.
   * Defaults to {@link DEFAULT_MAX_FEE_SOMPI} (0.1 ZKAS — far above any honest
   * byte-priced fee, far below a wallet's change). The signer reads the fee the
   * bundle ACTUALLY pays and refuses anything above this bound, so a malicious
   * prover cannot burn change as fee.
   */
  maxFeeSompi?: bigint;
  memo?: string;
  /**
   * Idempotency key for this payment: 1–128 characters, unique per payment (a
   * withdrawal id, an invoice number). The wallet service records each broadcast
   * under it for 24 hours, so retrying the same payment with the same id — after a
   * timeout, a crash, or a {@link SubmitOutcomeUnknownError} — returns what was
   * already sent instead of paying again. Strongly recommended for any automated
   * payment; required to retry safely.
   */
  requestId?: string;
  /**
   * A standard transaction spends at most 38 notes, so a fragmented wallet may
   * need several transactions for one payment. `true` (the default) sends in
   * chunks until the amount is covered; `false` refuses a payment that does not
   * fit one transaction instead of partially paying it.
   */
  allowChunking?: boolean;
}

/** One transaction of a logical payment that spanned several. */
export interface SendPart {
  txid: string;
  amountSompi: bigint;
  feeSompi: bigint;
}

export interface SendResult {
  /** First transaction id — kept for single-tx callers. */
  txid: string;
  txids: string[];
  parts: SendPart[];
  amountSompi: bigint;
  feeSompi: bigint;
}

export interface SendProgress {
  /** 1-based index of the transaction being built. */
  part: number;
  /** Best estimate of the total number of transactions, once known. */
  parts: number;
  sentSompi: bigint;
  totalSompi: bigint;
}

export type SendStage = "preparing" | "verifying" | "signing" | "broadcasting" | "submitted";

/** Mirror of walletd's `/api/status`. Optional fields come from newer daemons. */
export interface WalletStatus {
  has_wallet: boolean;
  address: string | null;
  network: string;
  node_connected: boolean;
  daa_score: number;
  synced: boolean;
  warming?: boolean;
  /** The connected node has pruned part of this wallet's history: the balance
   * is a LOWER BOUND and a rescan through this node would lose sight of older
   * notes. Surface this; silence is how "my coins vanished" happens. */
  missing_history?: boolean;
  scanned_blocks: number;
  chain_len: number;
  balance_sompi: string;
  spendable_sompi?: string;
  maturing_sompi?: string;
  note_count: number;
  updated_unix: number;
  error: string | null;
}

export interface WalletBalance {
  balance_sompi: string;
  synced: boolean;
  scanned_blocks: number;
  chain_len: number;
  notes: { position: number; value: number }[];
  updated_unix: number;
  error: string | null;
}

/** One output of a history row's transaction: for `received`, a payment to one of this wallet's addresses. */
export interface HistoryCredit {
  recipient: string;
  /** Diversifier index the address was issued at (`/address?index=`), as a decimal string: the customer id. Null on sent rows. */
  index?: string | null;
  amountSompi: number;
  /** Exact decimal string; `amountSompi` loses precision above 2^53. */
  amountSompiExact: string;
  amountZkas: number;
  memo?: string | null;
}

export interface HistoryRow {
  kind: "coinbase" | "received" | "sent";
  txid: string;
  daaScore: number;
  timestamp: number;
  /** For `received`: the SUM over `credits`. Never attribute a deposit from this. */
  amountSompi: number;
  /** Exact decimal string of `amountSompi`. */
  amountSompiExact?: string;
  amountZkas: number;
  amountKind?: "paid" | "netOutflow";
  feeSompi: number;
  feeSompiExact?: string;
  /** For `received`: false until the full transaction (memos) has been read. */
  feeKnown?: boolean;
  /**
   * For `received`: one address of the transaction, or null when it paid several. Never attribute
   * a deposit from this: credit each entry of `credits`, keyed on (txid, index).
   */
  recipient?: string | null;
  memo?: string | null;
  /**
   * One entry per output. Credit deposits from these, never from the row's own amount or
   * recipient; they must add up to `amountSompiExact`. Empty: no breakdown (coinbase, or a row
   * written by an older daemon) — hold such a received row for review.
   */
  credits?: HistoryCredit[];
}

/** One event of the deposit journal (`GET /api/wallet/deposits`). Key a ledger entry on `(txid, i)`. */
export interface DepositEvent {
  /** Sequence number: ask for `after: seq` next time. Never reused. */
  seq: number;
  kind: "credit" | "memo" | "rebuild";
  txid?: string;
  /** `credit`: the output's index among the transaction's credits to this wallet. */
  i?: number;
  recipient?: string;
  /** `credit`: the diversifier index of `recipient` as a decimal string (the customer id); null if not this wallet's. */
  index?: string | null;
  amountSompiExact?: string;
  memo?: string | null;
  /** `credit`: false until the full transaction was read; a `memo` event follows then. */
  memoKnown?: boolean;
  daaScore?: number;
  timestamp?: number;
  /** `memo`: the memos of each credit (`i`) of `txid`, once read. */
  credits?: { i: number; memo: string | null }[];
  /** `rebuild`: the wallet rescans from its birthday; every credit is written again as re-found. */
  restart?: "birthday";
  scannedDaa?: number;
}

export interface DepositPage {
  events: DepositEvent[];
  /** The newest event's sequence number in the journal; `after` equal to it returns nothing new. */
  last_seq: number;
  after: number;
}

/** What became of a payment sent with a `requestId` (`GET /api/wallet/requests/{id}`). */
export interface RequestStatus {
  request_id: string;
  /** `in_progress`: still being sent, retry later with the same id; `sent`: see `transactions`. */
  state: "in_progress" | "sent";
  amount_sompi_exact?: string;
  fee_sompi_exact?: string;
  tx_count?: number;
  transactions?: {
    txid: string;
    /** `landed`: accepted by a chain block (`depth` DAA below the tip); `pending`: not yet seen accepted; `returned_or_settled`: no longer pending (never landed and its coins came back, or settled by the scan). */
    state: "landed" | "pending" | "returned_or_settled" | "unknown";
    block?: string;
    daa_score?: number;
    depth?: number;
  }[];
  /** Other payments sent with the same id (the id was reused): their first txids. */
  other_payments_with_this_id?: string[];
}

export interface WalletHistory {
  recoverableHistory: boolean;
  total: number;
  rows: HistoryRow[];
  pendingOutgoing?: { txid: string; amountSompi: number; amountZkas: number; submittedDaa: number }[];
}
