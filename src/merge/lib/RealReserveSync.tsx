// Mounted once near the app root (see App.tsx). Polls real on-chain state for
// every real (chain-backed) DTR in the store -- the 2 Gate-9 fixtures plus
// any Reserve the user creates through this app -- and merges fresh reads
// into useAppStore via mergeOnChainReserve. Uses only direct, known-account
// reads (see packages/sdk/src/readOnly.ts) -- never getProgramAccounts, which
// is confirmed blocked on the public DevNet RPC.
import { useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { fetchReserveOnChain, fetchTokenBalanceRaw, DEVNET_FIXTURES } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";

const POLL_MS = 15_000;

export function RealReserveSync() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const dtrs = useAppStore((s) => s.dtrs);
  const mergeOnChainReserve = useAppStore((s) => s.mergeOnChainReserve);
  const syncRealHolding = useAppStore((s) => s.syncRealHolding);

  const chainBackedIds = dtrs.filter((d) => d.onChain).map((d) => d.id);
  const key = chainBackedIds.join(",") + "|" + (connected && publicKey ? publicKey.toBase58() : "");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const programId = new PublicKey(DEVNET_FIXTURES.programId);

    async function refreshOne(dtrId: string) {
      const dtr = useAppStore.getState().dtrs.find((d) => d.id === dtrId);
      if (!dtr?.onChain) return;
      try {
        const reserveAddress = new PublicKey(dtr.onChain.reserve);
        const mints = dtr.onChain.assets.map((a) => new PublicKey(a.mint));
        const onChain = await fetchReserveOnChain(connection, programId, reserveAddress, mints);
        if (!onChain || cancelled) return;
        mergeOnChainReserve(dtrId, {
          reserveId: dtr.onChain.reserveId,
          reserve: dtr.onChain.reserve,
          reserveTokenMint: dtr.onChain.reserveTokenMint,
          mintAuthority: dtr.onChain.mintAuthority,
          vaultAuthority: dtr.onChain.vaultAuthority,
          assets: dtr.onChain.assets.map((a) => ({
            mint: a.mint,
            symbol: a.symbol,
            decimals: a.decimals,
            weightBps: a.weightBps,
            reserveAsset: a.reserveAsset,
            vault: a.vault,
          })),
        }, onChain);

        if (connected && publicKey) {
          const balanceRaw = await fetchTokenBalanceRaw(connection, new PublicKey(dtr.onChain.reserveTokenMint), publicKey);
          if (!cancelled) {
            const refreshedDtr = useAppStore.getState().dtrs.find((d) => d.id === dtrId);
            syncRealHolding(dtrId, balanceRaw, refreshedDtr?.nav ?? 1);
          }
        }
      } catch {
        // Transient RPC failure -- next poll tick retries; keep prior state.
      }
    }

    async function refreshAll() {
      for (const id of chainBackedIds) {
        await refreshOne(id);
      }
    }

    refreshAll();
    const id = setInterval(refreshAll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connection, mergeOnChainReserve, syncRealHolding, connected, publicKey]);

  return null;
}
