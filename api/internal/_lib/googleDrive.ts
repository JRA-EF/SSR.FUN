// Plain REST calls against the Google Drive v3 and Sheets v4 APIs -- no SDK
// dependency, mirroring this repo's existing minimal-dependency convention
// (see api/internal/_lib/googleAuth.ts's header). Used only by
// api/internal/feedback-submit.ts.
import { getGoogleAccessToken } from "./googleAuth.js";

const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";
const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

export interface UploadedFile {
  id: string;
  webViewLink: string;
}

/** Uploads one file (as base64 content) into a specific Drive folder the service account has been shared access to. Throws with the real Google API error message on failure -- never silently drops a screenshot. */
export async function uploadFileToDriveFolder(folderId: string, filename: string, mimeType: string, base64Content: string): Promise<UploadedFile> {
  const accessToken = await getGoogleAccessToken();
  const metadata = { name: filename, parents: [folderId] };
  const boundary = `ssr_fun_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${base64Content}\r\n` +
    `--${boundary}--`;

  const res = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const json = (await res.json()) as { id?: string; webViewLink?: string; error?: { message?: string } };
  if (!res.ok || !json.id) {
    throw new Error(`Drive upload failed for "${filename}": ${json.error?.message || res.statusText}`);
  }
  return { id: json.id, webViewLink: json.webViewLink ?? `https://drive.google.com/file/d/${json.id}/view` };
}

/** True if the sheet's first row is genuinely empty (a brand-new sheet) -- used to write a header row exactly once, never overwriting real data. */
async function isSheetHeaderMissing(sheetId: string, accessToken: string): Promise<boolean> {
  const res = await fetch(`${SHEETS_BASE_URL}/${sheetId}/values/A1:H1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as { values?: string[][]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Sheets read failed: ${json.error?.message || res.statusText}`);
  return !json.values || json.values.length === 0;
}

export const FEEDBACK_SHEET_HEADER = ["Timestamp", "Reporter", "Area / Page", "Severity", "Description", "Steps to Reproduce", "Screenshots", "Status"];

/** Appends one feedback submission as a new row, writing the canonical header row first if this is the sheet's very first entry. */
export async function appendFeedbackRow(sheetId: string, row: string[]): Promise<void> {
  const accessToken = await getGoogleAccessToken();

  if (await isSheetHeaderMissing(sheetId, accessToken)) {
    const headerRes = await fetch(`${SHEETS_BASE_URL}/${sheetId}/values/A1:H1?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [FEEDBACK_SHEET_HEADER] }),
    });
    if (!headerRes.ok) {
      const errJson = (await headerRes.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Sheets header write failed: ${errJson.error?.message || headerRes.statusText}`);
    }
  }

  const appendRes = await fetch(`${SHEETS_BASE_URL}/${sheetId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!appendRes.ok) {
    const errJson = (await appendRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Sheets append failed: ${errJson.error?.message || appendRes.statusText}`);
  }
}
