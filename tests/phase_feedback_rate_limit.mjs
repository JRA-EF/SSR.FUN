// Public feedback endpoint guards (api/feedback/submit.ts): the pure rate-limit
// verdict order and the in-memory burst window. Plain mocha ESM (like
// phase_beta_gate.mjs) because lib/agent-feedback is an ESM scope.
import assert from 'node:assert/strict'
import { checkBurstWindow, rateLimitVerdict } from '../lib/agent-feedback/rateLimitPure.ts'

describe('feedback submit -- rate-limit verdict (pure)', () => {
  it('passes only when every window allows', () => {
    assert.equal(rateLimitVerdict(true, true, true), 'ok')
  })
  it('the cheap per-instance burst window is checked first, then per-IP, then global', () => {
    assert.equal(rateLimitVerdict(false, false, false), 'burst')
    assert.equal(rateLimitVerdict(true, false, false), 'ip')
    assert.equal(rateLimitVerdict(true, true, false), 'global')
  })
})

describe('feedback submit -- in-memory burst window', () => {
  it('allows up to maxCount hits per window, refuses the next, and resets after the window', () => {
    const key = 'test:' + Math.random()
    const t0 = 1_000_000
    assert.equal(checkBurstWindow(key, 600_000, 3, t0), true)
    assert.equal(checkBurstWindow(key, 600_000, 3, t0 + 1), true)
    assert.equal(checkBurstWindow(key, 600_000, 3, t0 + 2), true)
    assert.equal(checkBurstWindow(key, 600_000, 3, t0 + 3), false)
    assert.equal(checkBurstWindow(key, 600_000, 3, t0 + 600_000), true)
  })
})
