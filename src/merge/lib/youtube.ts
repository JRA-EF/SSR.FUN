/** Small parsing helpers for the creator-supplied YouTube links (see
 *  ReserveYoutube in lib/types.ts). No API calls -- just URL shapes. */

/** Extracts the 11-char video id from any common YouTube URL shape
 *  (watch?v=, youtu.be/, shorts/, embed/, live/) or accepts a bare id. */
export function parseYouTubeVideoId(input: string | undefined | null): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(url.hostname)) return null;
    const v = url.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = url.pathname.match(/^\/(?:shorts|embed|live)?\/?([A-Za-z0-9_-]{11})(?:$|\/)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** YouTube's public thumbnail for a video id. */
export function youTubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Normalizes a channel link to a URL, accepting bare @handles. */
export function normalizeYouTubeChannelUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("@")) return `https://www.youtube.com/${raw}`;
  return `https://${raw}`;
}
