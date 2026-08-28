// Browser-side helpers for the Reserve profile picture flow (ManageDTR's
// "Profile Picture" editor): normalize the picked file to a small square-ish
// image locally, upload it to this app's own permanent, content-addressed
// image store (api/devnet/reserve-image.ts / api/mainnet/reserve-image.ts,
// same route-pair convention as uploadReserveMetadata in
// createReserveClient.ts), and return the short permanent HTTPS URL that
// goes into the Reserve's off-chain metadata payload as `imageUrl` -- never
// the image bytes themselves.

/** Longest edge of the stored picture. Rendered at 80px and below everywhere in the app, so 512 keeps it crisp on high-DPI screens while staying far under the server's decoded-size cap. */
const MAX_DIMENSION = 512;

const ACCEPTED_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Reads a user-picked image file and re-encodes it as a bounded
 * `data:image/...;base64` string ready for uploadReserveImage: decoded via
 * the browser's own image pipeline (so a corrupt/non-image file fails here,
 * with a plain-language error, before any network request), downscaled to
 * MAX_DIMENSION on its longest edge, and re-encoded (WebP where the browser
 * supports encoding it, PNG otherwise). Re-encoding through a canvas also
 * strips EXIF/location metadata as a side effect -- the stored picture is
 * public. An animated GIF loses its animation (only the first frame
 * survives the canvas) -- acceptable for a profile picture.
 */
export async function fileToProfileImageDataUrl(file: File): Promise<string> {
  if (!ACCEPTED_INPUT_TYPES.includes(file.type)) {
    throw new Error("The profile picture must be a PNG, JPEG, WebP, or GIF image.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This file could not be read as an image -- try a different one."));
      img.src = objectUrl;
    });
    const scale = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not process the image -- try a different browser.");
    ctx.drawImage(image, 0, 0, width, height);
    const webp = canvas.toDataURL("image/webp", 0.85);
    // A browser without WebP *encoding* support silently returns a PNG data
    // URL from that call -- either way the result is one of the store's
    // accepted formats.
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Uploads a normalized picture (from fileToProfileImageDataUrl) and returns
 * its short permanent HTTPS URL. Idempotent server-side (content-hashed id,
 * `on conflict do nothing` insert -- see lib/reserve-image/payload.ts), so
 * a retry after a transient failure reuses the same stored row and URL.
 *
 * When `reserve` (the Reserve's on-chain address) is given, the upload ALSO
 * repoints that Reserve's currently-shown picture to this image server-side
 * (the reserve_image_pointer upsert -- see api/*\/reserve-image.ts's
 * pointer-flow header). This is the whole signature-free edit flow: no new
 * metadata payload, no update_metadata transaction, no wallet approval --
 * RealReserveSync's pointer merge makes every viewer pick it up.
 */
export async function uploadReserveImage(origin: string, dataUrl: string, cluster: "devnet" | "mainnet", reserve?: string): Promise<string> {
  const path = `/api/${cluster}/reserve-image`;
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reserve ? { dataUrl, reserve } : { dataUrl }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body && typeof body.error === "string" && body.error) || `Failed to upload the profile picture (HTTP ${response.status}).`);
  }
  if (!body || typeof body.id !== "string" || !body.id) {
    throw new Error("The profile picture upload did not return a valid id.");
  }
  return `${origin}${path}?id=${body.id}`;
}

/**
 * Fetches the full reserve-address -> picture-URL pointer map (see
 * api/*\/reserve-image.ts's GET ?pointers=1). The returned URLs are the
 * store's permanent content-addressed `?id=` form, so the browser's
 * immutable caching still applies to the bytes -- only this small map is
 * refetched. Best-effort by design: any failure returns an empty map, so a
 * pointer-service hiccup can only ever fall back to each Reserve's
 * metadata-embedded picture, never fail a discovery pass.
 */
export async function fetchReserveImagePointers(origin: string, cluster: "devnet" | "mainnet"): Promise<Record<string, string>> {
  const path = `/api/${cluster}/reserve-image`;
  try {
    const response = await fetch(`${origin}${path}?pointers=1`);
    if (!response.ok) return {};
    const body = (await response.json().catch(() => null)) as { pointers?: Record<string, unknown> } | null;
    if (!body || typeof body.pointers !== "object" || body.pointers === null) return {};
    const result: Record<string, string> = {};
    for (const [reserve, id] of Object.entries(body.pointers)) {
      if (typeof id === "string" && /^[0-9a-f]{16}$/.test(id)) result[reserve] = `${origin}${path}?id=${id}`;
    }
    return result;
  } catch {
    return {};
  }
}
