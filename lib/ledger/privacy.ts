// Privacy/security field-exclusion enforcement for the SSR Ledger -- pure,
// directly unit-tested. Implements the task's explicit "never log" list
// (private keys, seed phrases, wallet-signing payload secrets, API keys,
// authorization headers, session secrets, sensitive environment variables,
// complete RPC responses containing unnecessary sensitive data) as a real,
// enforced ALLOWLIST rather than a denylist -- a denylist only catches
// field names someone thought to ban in advance; an allowlist means an
// unrecognized field is dropped by default, the safer failure mode.

/**
 * The only keys ever permitted into ledger_product_events.metadata (a jsonb
 * column callers could otherwise stuff anything into). Deliberately small:
 * every key here is either already public on-chain (a wallet address, a
 * Reserve address) or a coarse UX signal (which page, which step, how long
 * something took) -- never a secret, never raw device/network identity.
 */
const PRODUCT_EVENT_METADATA_ALLOWLIST = new Set([
  "page",
  "step",
  "stepIndex",
  "durationMs",
  "reserve",
  "reserveTicker",
  "assetMint",
  "errorClass",
  "walletAdapterName",
  "rejectionReason",
  "resultStatus",
]);

/** Case/format-insensitive patterns for keys that must NEVER be persisted anywhere in the ledger, matched against object keys recursively. */
const FORBIDDEN_KEY_PATTERN = /(private[_-]?key|seed[_-]?phrase|secret[_-]?key|mnemonic|api[_-]?key|authorization|auth[_-]?header|session[_-]?secret|password|cookie|signing[_-]?payload)/i;

export interface SanitizeResult<T> {
  value: T;
  droppedKeys: string[];
}

/**
 * Allowlist-filters a metadata object for ledger_product_events, dropping
 * any key not explicitly permitted AND any key matching the forbidden
 * pattern (belt and suspenders: even an allowlisted key name is still
 * pattern-checked, so a caller can never accidentally allowlist their way
 * around the forbidden-content rule).
 */
export function sanitizeProductEventMetadata(input: Record<string, unknown> | null | undefined): SanitizeResult<Record<string, unknown>> {
  if (!input) return { value: {}, droppedKeys: [] };
  const value: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (!PRODUCT_EVENT_METADATA_ALLOWLIST.has(key) || FORBIDDEN_KEY_PATTERN.test(key)) {
      droppedKeys.push(key);
      continue;
    }
    // Only primitive values pass through -- an object/array could smuggle
    // an arbitrarily deep forbidden field past the top-level key check.
    if (val === null || ["string", "number", "boolean"].includes(typeof val)) {
      value[key] = val;
    } else {
      droppedKeys.push(key);
    }
  }
  return { value, droppedKeys };
}

/** True if any part of a string looks like it contains a forbidden secret category -- used to refuse persisting a summary/error message outright rather than merely logging a warning, since a secret in a `text` column is exactly as bad as one in a structured field. */
export function containsForbiddenContent(text: string | null | undefined): boolean {
  if (!text) return false;
  return FORBIDDEN_KEY_PATTERN.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/.test(text);
}

/**
 * Off-chain analytics retention policy (product events, sessions) -- a pure
 * data structure documenting the rule, not (yet) an enforced deletion job.
 * See docs/protocol/LEDGER_ARCHITECTURE.md's Privacy & Retention section
 * for the human-readable version this mirrors; kept here too so the policy
 * is checkable in code (tests/phase_ledger.ts asserts these numbers match
 * the documented ones), not just prose that can drift from what's built.
 */
export const RETENTION_POLICY = {
  /** Off-chain product/session analytics (ledger_product_events): raw session-level rows retained 400 days, then eligible for aggregation-only retention. On-chain data (ledger_events) is never subject to this -- it mirrors permanent, public chain state and is retained indefinitely. */
  productEventsRawRetentionDays: 400,
  /** IP addresses, device identifiers, and any other raw network/device identifier: NEVER stored by this schema at all (see ledger_product_events' own columns -- there is no ip_address/device_id/user_agent column to populate). If a future need for network-level abuse detection arises, it requires a SEPARATE, explicitly-scoped decision and table -- not a silent addition to this one. */
  ipAndDeviceIdentifiersStored: false,
} as const;
