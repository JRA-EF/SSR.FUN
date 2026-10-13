/**
 * Explicit compute-unit limit for a seed_reserve transaction of `assetCount`
 * assets. THE DEC-0166 ROOT-CAUSE FIX: seed_reserve was always submitted
 * without a setComputeUnitLimit instruction, so it ran under the runtime's
 * default ~200k budget -- measured real consumption is CU(n) ~= 53k + 16.7k*n
 * (CHARLI 4-asset seed: 119,408 CU; DELTA 10-asset seed, simulation-proven:
 * 219,754 CU), meaning a 10-asset seed can NEVER fit the default and died
 * deterministically at "exceeded CUs meter". This budgets ~2x the measured
 * model (headroom for init_if_needed ATA-creation variance, ~13.5k each),
 * capped at Solana's 1.4M per-transaction maximum. At the program's own
 * 12-asset validation cap this is 580k -- comfortably under the cap, which
 * is what makes 10-asset Reserves supportable with NO program change.
 * Priority-fee cost scales with the requested limit (price x limit), so this
 * stays deliberately proportional rather than a flat 1.4M.
 *
 * Its own module (DEC-0238) so the server-built seed (lib/mainnet/buildSeed.ts)
 * can share it without importing the browser Create client.
 */
export function seedComputeUnitLimit(assetCount: number): number {
  const count = Math.max(1, Math.ceil(assetCount));
  return Math.min(1_400_000, 100_000 + 40_000 * count);
}
