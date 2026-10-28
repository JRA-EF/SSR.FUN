// SOL balance samples of the protocol's fee-paying wallets, for the command
// center's burn rate (model.ts solBurnPerDay). The fee keeper records its own
// balance once per hourly run; the command center adds one per wallet at most
// hourly while the page is open. No imports on purpose: the keeper cron uses
// this file too.
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

let tableReady = false

async function ensureTable(db: Db): Promise<void> {
  if (tableReady) return
  await db`CREATE TABLE IF NOT EXISTS command_center_balances (
    wallet text NOT NULL, at timestamptz NOT NULL DEFAULT now(), sol double precision NOT NULL, PRIMARY KEY (wallet, at))`
  tableReady = true
}

/** Stores a sample unless this wallet already has one from the last 50 minutes. */
export async function recordSolSample(db: Db, wallet: string, sol: number): Promise<void> {
  if (!Number.isFinite(sol)) return
  await ensureTable(db)
  await db`INSERT INTO command_center_balances (wallet, sol)
    SELECT ${wallet}, ${sol} WHERE NOT EXISTS (
      SELECT 1 FROM command_center_balances WHERE wallet = ${wallet} AND at > now() - interval '50 minutes')`
  if (Math.random() < 0.02) await db`DELETE FROM command_center_balances WHERE at < now() - interval '90 days'`
}

/** The last `days` of samples per wallet, oldest first. */
export async function readSolSamples(db: Db, wallets: string[], days = 30): Promise<Map<string, { at: number; sol: number }[]>> {
  const out = new Map<string, { at: number; sol: number }[]>(wallets.map((w) => [w, []]))
  if (!wallets.length) return out
  await ensureTable(db)
  const rows = (await db`SELECT wallet, at, sol FROM command_center_balances
    WHERE wallet = ANY(${wallets}) AND at > now() - make_interval(days => ${days}) ORDER BY at`) as { wallet: string; at: string | Date; sol: number }[]
  for (const r of rows) out.get(r.wallet)?.push({ at: new Date(r.at).getTime(), sol: Number(r.sol) })
  return out
}
