// Ledger-only enrichment on top of packages/sdk/src/activityLog.ts's
// summarizeActivityEvent. That function is shared with ManageDTR.tsx's
// per-Reserve Activity tab and stays deliberately minimal (actor + one
// headline amount); the Ledger's wider column set (source/destination/
// vault accounts, fee-specific amounts, protocol/manager revenue splits)
// is a reporting concern unique to acquisition-grade CSV export, so it
// lives here instead of widening the shared function's contract for every
// other consumer. Pure and directly unit-tested -- reads only the raw
// decoded event fields already present in programs/ssr_protocol/src/
// events.rs (field names below are verbatim, camelCased by the Anchor
// coder).
const pk = (v: unknown): string | null => (v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58(): string }).toBase58() : null);
const addBig = (...vals: unknown[]): string => vals.reduce((sum: bigint, v) => sum + BigInt(String(v ?? 0)), 0n).toString();

export interface LedgerFieldExtraction {
  sourceAccount: string | null;
  destinationAccount: string | null;
  vault: string | null;
  feeAmountRaw: string | null;
  feeDestination: string | null;
  protocolRevenueRaw: string | null;
  managerRevenueRaw: string | null;
  /** Set only when this event carries an amount summarizeActivityEvent does NOT surface (currently just reserveAssetFunded's Reserve Asset deposit, which is denominated in the asset mint's own decimals, not the Reserve Token's -- see amountDecimalsUnknown below for why decimals/normalized are deliberately left null rather than guessed). */
  extraAmountRaw: string | null;
  extraAmountKind: "assetFunding" | null;
}

const EMPTY: LedgerFieldExtraction = {
  sourceAccount: null,
  destinationAccount: null,
  vault: null,
  feeAmountRaw: null,
  feeDestination: null,
  protocolRevenueRaw: null,
  managerRevenueRaw: null,
  extraAmountRaw: null,
  extraAmountKind: null,
};

export function extractLedgerFields(eventName: string, data: Record<string, unknown>): LedgerFieldExtraction {
  switch (eventName) {
    case "reserveAssetInitialized":
    case "reserveAssetAdded":
      return { ...EMPTY, vault: pk(data.vault) };
    case "reserveAssetFunded":
      return {
        ...EMPTY,
        vault: pk(data.vault),
        destinationAccount: pk(data.vault),
        extraAmountRaw: addBig(data.amount),
        extraAmountKind: "assetFunding",
      };
    case "reserveAssetRemoved":
      return { ...EMPTY, vault: pk(data.vault) };
    case "protocolMintFeeTransferred":
      return {
        ...EMPTY,
        destinationAccount: pk(data.destination),
        feeAmountRaw: addBig(data.amount),
        feeDestination: pk(data.destination),
        protocolRevenueRaw: addBig(data.amount),
      };
    case "protocolFeeCollected":
      return {
        ...EMPTY,
        destinationAccount: pk(data.destination),
        feeAmountRaw: addBig(data.amount),
        feeDestination: pk(data.destination),
        protocolRevenueRaw: addBig(data.amount),
      };
    case "tvlFeeSettled":
      // protocolFeeShares are transferred to protocolDestination; managerFeeShares
      // are accrued (no single transfer destination at this event -- recipients are
      // configured separately via managerFeeRecipientsConfigured and paid out later
      // via managerFeeShareCollected), so feeAmountRaw/feeDestination reflect only
      // the protocol-side transfer, while both revenue splits are still recorded.
      return {
        ...EMPTY,
        destinationAccount: pk(data.protocolDestination),
        feeAmountRaw: addBig(data.protocolFeeShares),
        feeDestination: pk(data.protocolDestination),
        protocolRevenueRaw: addBig(data.protocolFeeShares),
        managerRevenueRaw: addBig(data.managerFeeShares),
      };
    case "feesAccrued":
      // Legacy path: accrual only, nothing transferred yet -- no destination/feeAmountRaw.
      return {
        ...EMPTY,
        protocolRevenueRaw: addBig(data.protocolFeeSharesAccrued),
        managerRevenueRaw: addBig(data.managerFeeSharesAccrued),
      };
    case "feesCollected":
      // Legacy path: two independent destinations for one event -- destinationAccount
      // is deliberately left null (ambiguous which of the two it would mean); both
      // splits are still fully captured via the revenue columns.
      return {
        ...EMPTY,
        protocolRevenueRaw: addBig(data.protocolFeeSharesMinted),
        managerRevenueRaw: addBig(data.managerFeeSharesMinted),
      };
    case "managerFeeShareAccrued":
      return {
        ...EMPTY,
        managerRevenueRaw: addBig(...(Array.isArray(data.amounts) ? data.amounts : [])),
      };
    case "managerFeeShareCollected":
      // A claim of already-accrued balance, not new revenue (matches
      // activityLog.ts's managerFeeClaimed semantics -- never double-counted
      // against managerFeeShareAccrued's managerRevenueRaw).
      return {
        ...EMPTY,
        destinationAccount: pk(data.recipient),
        feeAmountRaw: addBig(data.amount),
        feeDestination: pk(data.recipient),
      };
    case "reserveTokensMinted":
      return { ...EMPTY, sourceAccount: pk(data.depositor) };
    case "reserveTokensRedeemed":
      return { ...EMPTY, sourceAccount: pk(data.redeemer) };
    case "rebalanceLegExecuted":
      return { ...EMPTY, sourceAccount: pk(data.mintSell), destinationAccount: pk(data.mintBuy) };
    default:
      return EMPTY;
  }
}
