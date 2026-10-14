// Shown on every merge page while this browser holds an unfinished mint or
// redemption that left assets in the wallet (DEC-0241) -- so the user is
// never left holding reserve assets without knowing how to get back to USDC.
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AlertCircle } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { findIncompleteTransactions, hasPendingRecords } from "@/lib/incompleteTransactions";
import { IS_MAINNET } from "@/lib/solana-config";

export function IncompleteTransactionsBanner() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const txInFlight = useAppStore((s) => s.txInFlight);
  const [path] = useLocation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!IS_MAINNET || !publicKey || txInFlight || !hasPendingRecords(publicKey.toBase58())) {
      setCount(0);
      return;
    }
    let cancelled = false;
    findIncompleteTransactions(connection, publicKey, () => null)
      .then((items) => !cancelled && setCount(items.length))
      .catch(() => !cancelled && setCount(0));
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, txInFlight, path]);

  if (count === 0 || path.startsWith("/recover")) return null;
  return (
    <div className="container mx-auto px-4 pt-4">
      <Link href="/recover" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm hover:underline">
        <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
        {count === 1 ? "A mint or redemption did not finish and left assets in your wallet." : `${count} mints or redemptions did not finish and left assets in your wallet.`} Review and convert them to USDC.
      </Link>
    </div>
  );
}
