/** Creator social links shown as icons beside a Reserve's ticker (X,
 *  Telegram, YouTube) plus the DexScreener lookup. Pure URL shaping -- no
 *  API calls. Entered on Launch step 1 and stored in the Reserve's metadata
 *  payload (xUrl / telegramUrl / youtubeChannelUrl). */

const X_HOSTS = /^(www\.|mobile\.)?(x|twitter)\.com$/i;
const TELEGRAM_HOSTS = /^(www\.)?(t\.me|telegram\.me|telegram\.dog)$/i;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TELEGRAM_HANDLE = /^[A-Za-z0-9_]{4,32}$/;

function parseLooseUrl(raw: string): URL | null {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** An X profile/community/post link, normalized to https://x.com/...;
 *  accepts @handle, a bare handle, or any x.com / twitter.com link. Null
 *  for anything else (empty input included). */
export function normalizeXUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const handle = raw.replace(/^@/, "");
  if (X_HANDLE.test(handle)) return `https://x.com/${handle}`;
  const url = parseLooseUrl(raw);
  if (!url || !X_HOSTS.test(url.hostname) || url.pathname.length <= 1) return null;
  return `https://x.com${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/** A Telegram channel/group/invite link, normalized to https://t.me/...;
 *  accepts @handle, a bare handle, or any t.me / telegram.me link. Null
 *  for anything else (empty input included). */
export function normalizeTelegramUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const handle = raw.replace(/^@/, "");
  if (TELEGRAM_HANDLE.test(handle)) return `https://t.me/${handle}`;
  const url = parseLooseUrl(raw);
  if (!url || !TELEGRAM_HOSTS.test(url.hostname) || url.pathname.length <= 1) return null;
  return `https://t.me${url.pathname.replace(/\/+$/, "")}`;
}

/** DexScreener's search for a token address. Opens the token's pairs when
 *  it trades on a DEX, an empty result page otherwise. */
export function dexScreenerSearchUrl(contractAddress: string): string {
  return `https://dexscreener.com/search?q=${encodeURIComponent(contractAddress.trim())}`;
}
