// SSR.FUN user feedback -> Google Sheet + Drive snapshots.
//
// Deployed as a Google Apps Script web app owned by joao@enigma-fund.com
// ("Execute as: Me", "Who has access: Anyone"). api/feedback/experience.ts
// POSTs one JSON submission per call; this script checks the shared secret,
// saves the snapshot (if any) to the Snapshots folder and appends one row with
// a link to it. Files stay private to the owner -- nothing is shared publicly.
//
// Setup (once): Project Settings -> Script Properties -> add FEEDBACK_SECRET
// with the same value as the Vercel env FEEDBACK_SHEET_SECRET. Then
// Deploy -> New deployment -> Web app, and put the /exec URL in the Vercel
// env FEEDBACK_SHEET_WEBHOOK_URL. See tools/feedback-sheet/README.md.

var SHEET_ID = '1CcPwOu3bZqECxNbE4neOkEeBY0mX1UD70SvBnB08Ygc'; // 'SSR.FUN feedback sheet'
var SNAPSHOT_FOLDER_ID = '1jYSgFDtBzItcoSdnSlaxJgZ4asVxWo98';
var HEADERS = ['Received (UTC)', 'Rating', 'Trigger', 'After action', 'Explanation', 'Snapshot', 'Page', 'Site', 'Wallet', 'Browser', 'ID'];
var IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Keeps user text as text: a cell starting with = + - @ would run as a formula.
function safe(v) {
  var s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// Opening the /exec URL in a browser: a health check, and how the owner grants
// the script its Sheets/Drive permission the first time.
function doGet() {
  return reply({ ok: true, service: 'ssr-fun-feedback' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad json' });
  }
  // Script Property FEEDBACK_SECRET; a deploy-time Secret.gs (never committed)
  // may define FEEDBACK_SECRET_INLINE instead.
  var secret = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SECRET') ||
    (typeof FEEDBACK_SECRET_INLINE === 'string' ? FEEDBACK_SECRET_INLINE : '');
  if (!secret || body.secret !== secret) return reply({ ok: false, error: 'unauthorized' });

  var rating = Number(body.rating);
  if (!(rating >= 1 && rating <= 5)) return reply({ ok: false, error: 'bad rating' });

  var snapshotUrl = '';
  var shot = body.screenshot;
  if (shot && shot.data && IMAGE_TYPES[shot.mimeType]) {
    var stamp = String(body.receivedAt || new Date().toISOString()).replace(/[:.]/g, '-');
    var name = stamp + '_' + rating + 'star_' + String(body.id || '').slice(0, 8) + '.' + IMAGE_TYPES[shot.mimeType];
    var blob = Utilities.newBlob(Utilities.base64Decode(shot.data), shot.mimeType, name);
    snapshotUrl = DriveApp.getFolderById(SNAPSHOT_FOLDER_ID).createFile(blob).getUrl();
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    }
    sheet.appendRow([
      safe(body.receivedAt),
      rating,
      safe(body.trigger),
      safe(body.action),
      safe(body.message),
      snapshotUrl,
      safe(body.pageUrl),
      safe(body.site),
      safe(body.wallet),
      safe(body.userAgent),
      safe(body.id),
    ]);
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true, snapshotUrl: snapshotUrl });
}
