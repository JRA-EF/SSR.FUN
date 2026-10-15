// Shown on every merge page while this browser holds an unfinished mint or
// redemption that left assets in the wallet (DEC-0241) -- so the user is
// never left holding reserve assets without knowing how to get back to USDC.
// A cancelled launch counts as unfinished; a completed mint's small unused
// swap buffer gets a quieter line of its own.
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AlertCircle, Info } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { findIncompleteTransactions, hasPendingRecords } from "@/lib/incompleteTransactions";
import { IS_MAINNET } from "@/lib/solana-config";

export function IncompleteTransactionsBanner() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const txInFlight = useAppStore((s) => s.txInFlight);
  const [path] = useLocation();
  const [counts, setCounts] = useState({ unfinished: 0, dust: 0 });

  useEffect(() => {
    if (!IS_MAINNET || !publicKey || txInFlight || !hasPendingRecords(publicKey.toBase58())) {
      setCounts({ unfinished: 0, dust: 0 });
      return;
    }
    let cancelled = false;
    findIncompleteTransactions(connection, publicKey, () => null)
      .then((items) => {
        if (cancelled) return;
        const dust = items.filter((i) => i.kind === "mint-dust").length;
        setCounts({ unfinished: items.length - dust, dust });
      })
      .catch(() => !cancelled && setCounts({ unfinished: 0, dust: 0 }));
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, txInFlight, path]);

  if (path.startsWith("/recover") || (counts.unfinished === 0 && counts.dust === 0)) return null;
  if (counts.unfinished === 0) {
    return (
      <div className="container mx-auto px-4 pt-4">
        <Link href="/recover" className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm hover:underline">
          <Info className="w-4 h-4 text-muted-foreground shrink-0" />
          Your mint left a small unused amount of the Reserve's assets in your wallet. Convert it to USDC.
        </Link>
      </div>
    );
  }
  return (
    <div className="container mx-auto px-4 pt-4">
      <Link href="/recover" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm hover:underline">
        <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
        {counts.unfinished === 1 ? "A mint, redemption or launch did not finish and left assets in your wallet." : `${counts.unfinished} mints, redemptions or launches did not finish and left assets in your wallet.`} Review and convert them to USDC.
      </Link>
    </div>
  );
}
