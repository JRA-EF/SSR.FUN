// Mounted once near the app root (see App.tsx). Runs the canonical on-chain
// discovery pass (see packages/sdk/src/discovery.ts) on mount and on a poll
// interval -- this is what makes ANY genuinely deployed Reserve show up in
// Discover/DTRDetail/Portfolio/ManageDTR, not just the 2 committed fixtures
// or whatever this browser's own localStorage happens to remember. See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase A" for the
// full requirement and docs/protocol/FRONTEND_INTEGRATION.md "Canonical
// discovery" for the architecture writeup.
//
// Uses only direct, known-account reads (see packages/sdk/src/discovery.ts)
// -- never getProgramAccounts, which is confirmed blocked on the public
// DevNet RPC. Failures are surfaced honestly via chainDiscoveryStatus rather
// than silently retried forever with no user-visible signal.
import { useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { discoverAllReserves, discoverDelegatesForReserve, fetchTokenBalanceRaw, DEVNET_FIXTURES, WRAPPED_SOL_MINT, DEVUSDC_MINT } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import { buildDtrFromDiscoveredReserve } from "./onChainReserve";

const POLL_MS = 15_000;

const CANDIDATE_ASSET_MINTS = [WRAPPED_SOL_MINT, DEVUSDC_MINT, ...Object.values(DEVNET_FIXTURES.mints).map((m) => new PublicKey(m.address))];

/** Wallets worth checking for a delegate grant on any given Reserve -- see discoverDelegatesForReserve's documented limitation (full enumeration needs a scan, not available on the public DevNet RPC). Always followed by a real on-chain verification; never trusted on its own. */
function candidateDelegateWallets(managerBase58: string, connectedWallet: string | null): PublicKey[] {
  const candidates = new Set([managerBase58, DEVNET_FIXTURES.delegates.updateTargets.wallet, DEVNET_FIXTURES.delegates.pauseUnpause.wallet]);
  if (connectedWallet) candidates.add(connectedWallet);
  return Array.from(candidates).map((c) => new PublicKey(c));
}

export function RealReserveSync() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const applyDiscoveredReserves = useAppStore((s) => s.applyDiscoveredReserves);
  const syncRealHolding = useAppStore((s) => s.syncRealHolding);
  const setChainDiscoveryStatus = useAppStore((s) => s.setChainDiscoveryStatus);

  const walletKey = connected && publicKey ? publicKey.toBase58() : null;

  useEffect(() => {
    let cancelled = false;
    const programId = new PublicKey(DEVNET_FIXTURES.programId);

    async function runDiscovery() {
      setChainDiscoveryStatus("loading");
      try {
        const { reserves, protocolConfig, issues } = await discoverAllReserves(connection, programId, CANDIDATE_ASSET_MINTS);
        if (cancelled) return;
        if (!protocolConfig) {
          setChainDiscoveryStatus("error", "SSR Protocol is not initialized on this DevNet endpoint.");
          return;
        }
        if (issues.length > 0) {
          // Partial-success state: real Reserves were still found and are
          // still applied below -- a malformed/unreadable account elsewhere
          // must never invalidate otherwise-valid discovered state. Still
          // surfaced honestly rather than silently swallowed.
          console.warn(`Discovery found ${issues.length} account issue(s) this pass (non-fatal):`, issues);
        }

        const dtrs = await Promise.all(
          reserves.map(async (reserve) => {
            const delegates = await discoverDelegatesForReserve(
              connection,
              programId,
              new PublicKey(reserve.reserve),
              candidateDelegateWallets(reserve.manager, walletKey),
            ).catch(() => []); // Delegate resolution is best-effort/supplementary -- a failure here shouldn't fail the whole Reserve's discovery.
            return buildDtrFromDiscoveredReserve(reserve, delegates, walletKey);
          }),
        );
        if (cancelled) return;
        applyDiscoveredReserves(dtrs, issues.length === 0);
        setChainDiscoveryStatus("ready");

        if (walletKey && publicKey) {
          for (const dtr of dtrs) {
            if (!dtr.onChain) continue;
            try {
              const balanceRaw = await fetchTokenBalanceRaw(connection, new PublicKey(dtr.onChain.reserveTokenMint), publicKey);
              syncRealHolding(dtr.id, balanceRaw, dtr.nav);
            } catch {
              // Transient RPC failure on one balance read -- next poll tick retries; don't fail the whole pass.
            }
          }
        }
      } catch (e) {
        if (!cancelled) setChainDiscoveryStatus("error", e instanceof Error ? e.message : "DevNet discovery failed.");
      }
    }

    runDiscovery();
    const id = setInterval(runDiscovery, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, walletKey, applyDiscoveredReserves, syncRealHolding, setChainDiscoveryStatus, publicKey]);

  return null;
}
