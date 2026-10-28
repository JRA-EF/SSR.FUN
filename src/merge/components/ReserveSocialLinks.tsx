import type { ReactNode } from "react";
import { dexScreenerSearchUrl } from "@/lib/reserveSocials";

// Small round link icons beside a Reserve's ticker: the creator's X,
// Telegram and YouTube (each only when set at launch) and a DexScreener
// lookup of the Reserve Token's contract address (always, once the address
// is known). The installed lucide-react build has no brand icons, hence the
// inline marks.

function XMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function YoutubeMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" />
    </svg>
  );
}

function IconLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full text-muted-foreground bg-muted/60 hover:text-foreground hover:bg-muted transition-colors"
      style={{ textDecoration: "none" }}
    >
      {children}
    </a>
  );
}

export function ReserveSocialLinks({
  xUrl,
  telegramUrl,
  youtubeUrl,
  contractAddress,
  className = "",
}: {
  xUrl?: string;
  telegramUrl?: string;
  youtubeUrl?: string;
  /** The Reserve Token's contract address; the DexScreener icon is shown only once it is known. */
  contractAddress?: string | null;
  className?: string;
}) {
  if (!xUrl && !telegramUrl && !youtubeUrl && !contractAddress) return null;
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {xUrl && (
        <IconLink href={xUrl} label="X">
          <XMark />
        </IconLink>
      )}
      {telegramUrl && (
        <IconLink href={telegramUrl} label="Telegram">
          <TelegramMark />
        </IconLink>
      )}
      {youtubeUrl && (
        <IconLink href={youtubeUrl} label="YouTube">
          <YoutubeMark />
        </IconLink>
      )}
      {contractAddress && (
        <IconLink href={dexScreenerSearchUrl(contractAddress)} label="DexScreener">
          <img src="/logo-dexscreener.png" alt="" className="w-6 h-6 rounded-full" />
        </IconLink>
      )}
    </div>
  );
}
