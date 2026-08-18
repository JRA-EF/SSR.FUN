// CSV export for ledger_events -- pure formatting/filtering logic here
// (directly unit-tested), the actual Postgres query lives in
// lib/ledger/query.ts. One row per structured event, never one row per
// free-text summary -- every business fact a report needs is in its own
// column; `summary` is included for human readability only and is never
// required to reconstruct a fact already present in a structured column.

/**
 * Stable column order -- append-only. Never reorder or remove a column
 * once shipped; a consumer (a spreadsheet, a due-diligence script) may
 * depend on positional column meaning. Add new fields at the end.
 */
export const LEDGER_EVENT_CSV_COLUMNS = [
  "event_id",
  "cluster",
  "program_id",
  "signature",
  "slot",
  "block_time_unix",
  "event_ts_utc",
  "event_date_utc",
  "instruction_index",
  "inner_instruction_index",
  "event_index",
  "instruction_name",
  "event_type",
  "category",
  "status",
  "error_code",
  "error_message",
  "actor_wallet",
  "actor_role",
  "fee_payer",
  "reserve",
  "reserve_token_mint",
  "reserve_asset_mint",
  "source_account",
  "destination_account",
  "vault",
  "amount_raw",
  "amount_decimals",
  "amount_normalized",
  "amount_kind",
  "usd_price_at_event",
  "usd_price_source",
  "usd_value_at_event",
  "fee_amount_raw",
  "fee_destination",
  "protocol_revenue_raw",
  "manager_revenue_raw",
  "compute_units_consumed",
  "network_fee_lamports",
  "priority_fee_lamports",
  "confirmation_status",
  "summary",
  "ingestion_source",
  "ingestion_ts",
  "decoder_version",
] as const;

export type LedgerEventCsvColumn = (typeof LEDGER_EVENT_CSV_COLUMNS)[number];
export type LedgerEventCsvRow = Record<LedgerEventCsvColumn, string | number | boolean | null | undefined>;

/** RFC 4180 field escaping -- wraps in quotes and doubles any embedded quote whenever the field contains a comma, quote, or newline. */
export function csvField(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(",") + "\r\n";
}

export function ledgerEventCsvHeader(): string {
  return csvRow([...LEDGER_EVENT_CSV_COLUMNS]);
}

export function ledgerEventToCsvRow(row: LedgerEventCsvRow): string {
  return csvRow(LEDGER_EVENT_CSV_COLUMNS.map((col) => row[col]));
}

/** "YYYY-MM-DD" validation -- the only date format ledger date filters accept, matching Postgres `date` columns exactly (no timezone ambiguity: every stored date is already UTC). */
export function isValidUtcDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export interface DateRangeFilter {
  fromDateUtc: string;
  toDateUtc: string;
}

/** Pure: validates and normalizes a date-range request (swaps if reversed, rejects invalid dates) -- the same validation both the exact-date and range export paths share. */
export function normalizeDateRange(fromDateUtc: string, toDateUtc: string): DateRangeFilter | { error: string } {
  if (!isValidUtcDateString(fromDateUtc) || !isValidUtcDateString(toDateUtc)) {
    return { error: "Dates must be in YYYY-MM-DD (UTC) format." };
  }
  return fromDateUtc <= toDateUtc ? { fromDateUtc, toDateUtc } : { fromDateUtc: toDateUtc, toDateUtc: fromDateUtc };
}

/** Pure, offline-testable version of the date-range filter itself, operating on an in-memory row list -- the real export queries Postgres with an equivalent WHERE clause (lib/ledger/query.ts), but this lets the FILTERING LOGIC be verified without a database. */
export function filterRowsByDateRange<T extends { event_date_utc: string }>(rows: T[], range: DateRangeFilter): T[] {
  return rows.filter((r) => r.event_date_utc >= range.fromDateUtc && r.event_date_utc <= range.toDateUtc);
}
