// POST /api/internal/feedback-submit -- internal-team-only DevNet bug/feedback
// intake. Gated by the exact same session cookie as /internal/status (see
// middleware.ts, which blocks this path at the edge before this handler ever
// runs) -- independently re-verified here too, matching
// api/dashboard/content.ts's "never depend solely on middleware" precedent.
//
// On a valid, authenticated submission: uploads any attached screenshots into
// a specific Google Drive folder (FEEDBACK_DRIVE_FOLDER_ID) and appends one
// row (reporter, area, severity, description, repro steps, screenshot links,
// status) to a specific Google Sheet (FEEDBACK_SHEET_ID) via a Google service
// account (GOOGLE_SERVICE_ACCOUNT_KEY) -- see api/internal/_lib/googleAuth.ts
// and googleDrive.ts. Both IDs point at real, already-created Drive
// resources; the service account must be shared on both (Editor access)
// before this endpoint can succeed -- see docs/project/DECISION_LOG.md for
// the exact setup this pass required.
import type { DashboardRequest, DashboardResponse } from "../../lib/dashboard/http.js";
import { parseCookie, SESSION_COOKIE_NAME, verifySessionCookie } from "../../lib/dashboard/session.js";
import { appendFeedbackRow, uploadFileToDriveFolder } from "./_lib/googleDrive.js";

const MAX_SCREENSHOTS = 3;
// Raw (pre-base64) byte cap per screenshot -- keeps the total request body
// comfortably under Vercel's ~4.5MB default limit for a Node serverless
// function even with base64's ~33% inflation and JSON/metadata overhead.
const MAX_SCREENSHOT_BYTES = 1_200_000;
const ALLOWED_AREAS = ["Home", "Discover", "Create a Reserve", "Portfolio", "Manage Reserve", "Reserve Detail", "Internal Dashboard", "Other"];
const ALLOWED_SEVERITIES = ["Critical", "High", "Medium", "Low", "Cosmetic"];

interface ScreenshotInput {
  filename?: unknown;
  mimeType?: unknown;
  base64?: unknown;
}

interface FeedbackBody {
  reporterName?: unknown;
  area?: unknown;
  severity?: unknown;
  description?: unknown;
  stepsToReproduce?: unknown;
  screenshots?: unknown;
}

function parseBody(req: DashboardRequest): FeedbackBody {
  if (req.body && typeof req.body === "object") return req.body as FeedbackBody;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function base64ByteLength(base64: string): number {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  return Math.floor((clean.length * 3) / 4);
}

export default async function handler(req: DashboardRequest, res: DashboardResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Independently re-verified -- never rely solely on middleware.ts (see
  // api/dashboard/content.ts for the identical precedent in this repo).
  const configuredPassword = process.env.SSR_DASHBOARD_PASSWORD ?? "";
  const cookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie;
  const sessionValue = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  const authenticated = await verifySessionCookie(sessionValue, configuredPassword);
  if (!authenticated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const folderId = process.env.FEEDBACK_DRIVE_FOLDER_ID ?? "";
  const sheetId = process.env.FEEDBACK_SHEET_ID ?? "";
  if (!folderId || !sheetId) {
    res.status(500).json({ error: "Feedback intake is not configured on this deployment (missing FEEDBACK_DRIVE_FOLDER_ID/FEEDBACK_SHEET_ID)." });
    return;
  }

  const body = parseBody(req);
  const reporterName = typeof body.reporterName === "string" ? body.reporterName.trim() : "";
  const area = typeof body.area === "string" ? body.area : "";
  const severity = typeof body.severity === "string" ? body.severity : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const stepsToReproduce = typeof body.stepsToReproduce === "string" ? body.stepsToReproduce.trim() : "";
  const screenshotsRaw = Array.isArray(body.screenshots) ? (body.screenshots as ScreenshotInput[]) : [];

  if (!reporterName) {
    res.status(400).json({ error: "reporterName is required." });
    return;
  }
  if (!ALLOWED_AREAS.includes(area)) {
    res.status(400).json({ error: `area must be one of: ${ALLOWED_AREAS.join(", ")}` });
    return;
  }
  if (!ALLOWED_SEVERITIES.includes(severity)) {
    res.status(400).json({ error: `severity must be one of: ${ALLOWED_SEVERITIES.join(", ")}` });
    return;
  }
  if (!description) {
    res.status(400).json({ error: "description is required." });
    return;
  }
  if (screenshotsRaw.length > MAX_SCREENSHOTS) {
    res.status(400).json({ error: `At most ${MAX_SCREENSHOTS} screenshots per submission.` });
    return;
  }
  for (const s of screenshotsRaw) {
    if (typeof s.filename !== "string" || typeof s.mimeType !== "string" || typeof s.base64 !== "string" || !s.base64) {
      res.status(400).json({ error: "Each screenshot needs filename, mimeType, and base64 content." });
      return;
    }
    if (!s.mimeType.startsWith("image/")) {
      res.status(400).json({ error: `Unsupported screenshot type: ${s.mimeType}. Only images are accepted.` });
      return;
    }
    if (base64ByteLength(s.base64) > MAX_SCREENSHOT_BYTES) {
      res.status(400).json({ error: `"${s.filename}" is too large -- each screenshot must be under ${Math.floor(MAX_SCREENSHOT_BYTES / 1_000_000)}MB.` });
      return;
    }
  }

  try {
    const uploaded: string[] = [];
    for (const s of screenshotsRaw) {
      const filename = s.filename as string;
      const mimeType = s.mimeType as string;
      const base64 = s.base64 as string;
      const result = await uploadFileToDriveFolder(folderId, filename, mimeType, base64);
      uploaded.push(result.webViewLink);
    }

    await appendFeedbackRow(sheetId, [
      new Date().toISOString(),
      reporterName,
      area,
      severity,
      description,
      stepsToReproduce,
      uploaded.join(" | "),
      "New",
    ]);

    res.status(200).json({ ok: true, screenshotLinks: uploaded });
  } catch (e) {
    // Never a fabricated success -- a genuine Drive/Sheets failure (e.g. the
    // service account hasn't been shared on the folder/sheet yet) surfaces
    // as an honest error, not a silently-dropped submission.
    res.status(502).json({ error: e instanceof Error ? e.message : "Failed to record this submission to Google Drive." });
  }
}
