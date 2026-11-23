// DEC-0296: cancelling an unfinished Reserve launch is an APP-level choice,
// not an on-chain one. close_reserve needs WindDown, which needs Active, so a
// Reserve that was never seeded cannot be closed without a program upgrade.
// "Cancel" therefore only hides the launch from its creator's Manage page, on
// every device, and can be undone. Nothing changes on-chain.
//
// The creator's wallet signs one of the messages below; the server
// (api/mainnet/unfinished-launches.ts) accepts it only when the ed25519
// signature matches this exact text, the message is fresh, and the wallet is
// the Reserve's on-chain manager while the Reserve is still unfinished.
// Pure on purpose: shared by the browser (to build the text it asks the
// wallet to sign) and the server, and tested offline.

export type LaunchCancelAction = 'cancel' | 'undo'

/** A signed cancel/undo older (or newer) than this is refused, so a captured signature cannot be replayed later. */
export const LAUNCH_CANCEL_MAX_AGE_MS = 10 * 60_000

export function launchCancelMessage(p: { action: LaunchCancelAction; reserve: string; wallet: string; issuedAt: string }): string {
  return [
    p.action === 'cancel' ? 'SSR.FUN: cancel an unfinished Reserve launch' : 'SSR.FUN: undo cancelling an unfinished Reserve launch',
    '',
    p.action === 'cancel'
      ? 'Hide this unfinished launch from my Manage page. Nothing changes on-chain.'
      : 'Show this unfinished launch on my Manage page again.',
    `Reserve: ${p.reserve}`,
    `Manager wallet: ${p.wallet}`,
    `Issued: ${p.issuedAt}`,
  ].join('\n')
}

export interface LaunchCancelRequest {
  action: unknown
  reserve: unknown
  wallet: unknown
  issuedAt: unknown
  signature: unknown
}

export type LaunchCancelShapeCheck =
  | { ok: true; action: LaunchCancelAction; reserve: string; wallet: string; issuedAt: string; signature: string }
  | { ok: false; status: number; error: string }

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Pure: validates the request body's shape and freshness (no signature or chain check yet). */
export function checkLaunchCancelShape(body: LaunchCancelRequest, now: number): LaunchCancelShapeCheck {
  const { action, reserve, wallet, issuedAt, signature } = body
  if (action !== 'cancel' && action !== 'undo') return { ok: false, status: 400, error: 'action must be "cancel" or "undo".' }
  if (typeof reserve !== 'string' || !BASE58_RE.test(reserve) || typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return { ok: false, status: 400, error: 'Missing or invalid reserve or wallet.' }
  }
  if (typeof issuedAt !== 'string' || typeof signature !== 'string' || signature.length === 0) return { ok: false, status: 400, error: 'Missing signature.' }
  const ms = Date.parse(issuedAt)
  if (!Number.isFinite(ms) || Math.abs(now - ms) > LAUNCH_CANCEL_MAX_AGE_MS) return { ok: false, status: 400, error: 'That signature has expired. Please sign again.' }
  return { ok: true, action, reserve, wallet, issuedAt, signature }
}

/**
 * Pure: the on-chain part of the decision, given a fresh read of the Reserve
 * (`null` = no such Reserve account). Cancel needs the Reserve to still be
 * unfinished; undo only needs the signer to be its manager (undoing a hide on
 * a Reserve that has since been finished is harmless).
 */
export function checkLaunchCancelOnChain(
  action: LaunchCancelAction,
  wallet: string,
  onChain: { manager: string; status: string } | null,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!onChain) return { ok: false, status: 404, error: 'No Reserve was found at that address.' }
  if (onChain.manager !== wallet) return { ok: false, status: 403, error: "Only the Reserve's manager wallet can do this." }
  if (action === 'cancel' && onChain.status !== 'created' && onChain.status !== 'assetsInitializing') {
    return { ok: false, status: 409, error: 'This Reserve has already finished launching, so there is nothing to cancel.' }
  }
  return { ok: true }
}

/** Pure: splits a wallet's unfinished launches into the ones shown and the ones it cancelled (hidden unless asked). */
export function splitCancelledLaunches<T extends { reserve: string }>(launches: T[], cancelledReserves: Iterable<string>): { visible: T[]; cancelled: T[] } {
  const hidden = new Set(cancelledReserves)
  return { visible: launches.filter((l) => !hidden.has(l.reserve)), cancelled: launches.filter((l) => hidden.has(l.reserve)) }
}
