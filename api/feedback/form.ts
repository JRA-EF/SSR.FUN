// GET /api/feedback/form -- legacy URL of the feedback form. The form now
// lives at /feedback (feedback.html, a Vite entry so it can load Vercel
// BotID's client script; submit is BotID-checked + rate-limited). Kept only
// so any old link keeps working.
interface Req { method?: string }
interface Res {
  status: (n: number) => Res
  setHeader: (k: string, v: string) => void
  end: () => void
}

export default function handler(_req: Req, res: Res) {
  res.setHeader('Location', '/feedback')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.status(302).end()
}
