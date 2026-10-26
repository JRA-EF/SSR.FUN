// Validation for the in-app "How did we do?" feedback (api/feedback/experience.ts).
// Pure, no imports, so it is unit-tested directly (tests/phase_user_feedback.ts).

export const EXPERIENCE_MESSAGE_MAX = 500
export const EXPERIENCE_SCREENSHOT_MAX_BASE64 = 3_000_000 // ~2.2 MB image; the client downscales first
export const EXPERIENCE_SCREENSHOT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const EXPERIENCE_TRIGGERS = ['button', 'prompt'] as const
export const EXPERIENCE_ACTIONS = [
  'mint', 'redeem', 'rebalance', 'create-reserve', 'liquidity',
] as const

export type ExperienceAction = (typeof EXPERIENCE_ACTIONS)[number]

export interface ExperienceSubmission {
  rating: number
  message: string
  trigger: (typeof EXPERIENCE_TRIGGERS)[number]
  action: ExperienceAction | null
  pageUrl: string | null
  wallet: string | null
  screenshot: { mimeType: string; data: string } | null
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

/** Parse an untrusted request body. Returns the submission or a user-facing error. */
export function parseExperience(body: Record<string, unknown>): { ok: true; value: ExperienceSubmission } | { ok: false; error: string } {
  const rating = typeof body.rating === 'number' ? body.rating : Number(body.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Pick a rating from 1 to 5 stars.' }

  const rawMessage = typeof body.message === 'string' ? body.message.trim() : ''
  if (rawMessage.length > EXPERIENCE_MESSAGE_MAX) return { ok: false, error: `Keep the explanation under ${EXPERIENCE_MESSAGE_MAX} characters.` }

  const trigger = EXPERIENCE_TRIGGERS.includes(body.trigger as never) ? (body.trigger as ExperienceSubmission['trigger']) : 'button'
  const action = EXPERIENCE_ACTIONS.includes(body.action as never) ? (body.action as ExperienceAction) : null
  const wallet = str(body.wallet, 64)

  let screenshot: ExperienceSubmission['screenshot'] = null
  const shot = body.screenshot as { mimeType?: unknown; data?: unknown } | null | undefined
  if (shot && typeof shot === 'object') {
    if (!EXPERIENCE_SCREENSHOT_TYPES.includes(shot.mimeType as never)) return { ok: false, error: 'Snapshots must be JPEG, PNG or WebP images.' }
    if (typeof shot.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.data)) return { ok: false, error: 'The snapshot could not be read.' }
    if (shot.data.length > EXPERIENCE_SCREENSHOT_MAX_BASE64) return { ok: false, error: 'The snapshot is too large.' }
    screenshot = { mimeType: shot.mimeType as string, data: shot.data }
  }

  return {
    ok: true,
    value: {
      rating,
      message: rawMessage,
      trigger,
      action,
      pageUrl: str(body.pageUrl, 400),
      wallet: wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/.test(wallet) ? wallet : null,
      screenshot,
    },
  }
}

/** Spreadsheets run a cell that starts with = + - @ as a formula; prefix ' so user text stays text. */
export function sheetSafe(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v
}
