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
var HEADERS = ['Received (UTC)', 'Rating', 'Subject', 'Details', 'Snapshot', 'Trigger', 'After action', 'Page', 'Site', 'Wallet', 'Browser', 'ID', 'Status'];
// The team sets Status by hand; empty means open. /internal/commandcenter counts open rows.
var STATUS_COL = 13;
var STATUS_CHOICES = ['Open', 'In progress', 'Resolved', "Won't fix", 'Duplicate', 'Test'];
var CLOSED = ['resolved', 'done', 'fixed', 'closed', "won't fix", 'wont fix', 'duplicate', 'test'];
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

// Row 1 matches HEADERS, and the Status column offers a dropdown (free text is still allowed).
function ensureHeader(sheet) {
  var head = sheet.getRange(1, 1, 1, HEADERS.length);
  if (head.getValues()[0].join('|') !== HEADERS.join('|')) {
    head.setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_CHOICES, true).setAllowInvalid(true).build();
    sheet.getRange(2, STATUS_COL, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  }
}

// Counts for /internal/commandcenter: open = Status empty, Open or In progress (anything not in CLOSED).
function stats() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeader(sheet);
  var last = sheet.getLastRow();
  var rows = last > 1 ? sheet.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
  var now = Date.now(), week = 7 * 86400000;
  var total = 0, last7d = 0, sum7d = 0, open = 0, openLow = 0, openRows = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rating = Number(r[1]);
    if (!(rating >= 1 && rating <= 5)) continue;
    total++;
    var at = r[0] instanceof Date ? r[0].getTime() : Date.parse(String(r[0]).replace(/^'/, ''));
    if (at && now - at < week) { last7d++; sum7d += rating; }
    var status = String(r[STATUS_COL - 1] || '').trim();
    if (CLOSED.indexOf(status.toLowerCase()) === -1) {
      open++;
      if (rating <= 2) openLow++;
      openRows.push({ at: at ? new Date(at).toISOString() : '', rating: rating, subject: String(r[2] || '').replace(/^'/, '').slice(0, 150), status: status, row: i + 2 });
    }
  }
  openRows.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  return { ok: true, total: total, last7d: last7d, avgRating7d: last7d ? sum7d / last7d : null, open: open, openLow: openLow, newestOpen: openRows.slice(0, 8) };
}

// Sets Status on rows given as [{row, at}]. A row is only written when its Received
// cell still matches `at`, so a sorted or edited sheet never gets the wrong row marked.
function setStatus(rows, status) {
  if (STATUS_CHOICES.indexOf(status) === -1 || !Array.isArray(rows) || rows.length > 100) return { ok: false, error: 'bad request' };
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  ensureHeader(sheet);
  var done = [], skipped = [];
  for (var i = 0; i < rows.length; i++) {
    var n = Number(rows[i] && rows[i].row);
    if (!(n >= 2 && n <= sheet.getLastRow())) { skipped.push(n); continue; }
    var cell = sheet.getRange(n, 1).getValue();
    var at = cell instanceof Date ? cell.toISOString() : String(cell).replace(/^'/, '');
    if (Date.parse(at) !== Date.parse(String(rows[i].at))) { skipped.push(n); continue; }
    sheet.getRange(n, STATUS_COL).setValue(status);
    done.push(n);
  }
  return { ok: true, done: done, skipped: skipped };
}

// DEC-0276: public BETA key claims (api/site/claim.ts) go into the team's
// existing key inventory, "SSR.fun BETA Access Keys (master)" (first tab), one
// row per key in its own column layout. Columns are found by their row-1
// header, so reordering them in the Sheet is safe; "X handle" and "Email" are
// added in the first empty header cells if missing. When a key is first used
// (api/site/login.ts), beta-used fills in Used / First used on for its row.
var KEYS_SHEET_ID = '1MJJFXeE66JmHrHHM8eaWCYfZmEhxTzQxJgL8iISZ6jQ'; // SSR.fun BETA Access Keys (master)
var KEYS_EXTRA_HEADERS = ['X handle', 'Email'];

function keysSheet() {
  var sheet = SpreadsheetApp.openById(KEYS_SHEET_ID).getSheets()[0];
  var width = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  for (var i = 0; i < KEYS_EXTRA_HEADERS.length; i++) {
    if (head.indexOf(KEYS_EXTRA_HEADERS[i]) !== -1) continue;
    var free = head.indexOf('');
    if (free === -1) { free = head.length; head.push(''); }
    head[free] = KEYS_EXTRA_HEADERS[i];
    sheet.getRange(1, free + 1).setValue(KEYS_EXTRA_HEADERS[i]).setFontWeight('bold');
  }
  var col = {};
  for (var c = 0; c < head.length; c++) if (head[c]) col[head[c]] = c;
  return { sheet: sheet, col: col, width: head.length };
}

function betaClaim(body) {
  if (!body.handle || !body.key) return { ok: false, error: 'bad beta claim' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var k = keysSheet(), sheet = k.sheet, col = k.col;
    // One row per key: a retried copy never duplicates.
    if (col['Key'] !== undefined && sheet.getLastRow() > 1) {
      var keys = sheet.getRange(2, col['Key'] + 1, sheet.getLastRow() - 1, 1).getValues();
      for (var r = 0; r < keys.length; r++) if (String(keys[r][0]).trim() === body.key) return { ok: true, duplicate: true };
    }
    var nums = col['#'] !== undefined && sheet.getLastRow() > 1 ? sheet.getRange(2, col['#'] + 1, sheet.getLastRow() - 1, 1).getValues() : [];
    var next = 1;
    for (var n = 0; n < nums.length; n++) { var v = Number(nums[n][0]); if (v >= next) next = v + 1; }
    var row = [];
    for (var i = 0; i < k.width; i++) row.push('');
    function put(name, value) { if (col[name] !== undefined) row[col[name]] = value; }
    put('#', next);
    put('Key', body.key);
    put('Type', 'BETA');
    put('Session length', '30 days');
    put('Batch', 'Self-serve ssr.fun/beta (DEC-0276)');
    put('Active in Vercel', 'Yes');
    put('Issued to', safe(body.handle));
    put('Issued on', safe(String(body.claimedAt || '').slice(0, 10)));
    put('Used', 'No');
    put('X handle', safe(body.handle));
    put('Email', safe(body.email));
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function betaUsed(body) {
  if (!body.key) return { ok: false, error: 'bad beta used' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var k = keysSheet(), sheet = k.sheet, col = k.col;
    if (col['Key'] === undefined || sheet.getLastRow() < 2) return { ok: true, found: false };
    var keys = sheet.getRange(2, col['Key'] + 1, sheet.getLastRow() - 1, 1).getValues();
    for (var r = 0; r < keys.length; r++) {
      if (String(keys[r][0]).trim() !== body.key) continue;
      if (col['Used'] !== undefined) sheet.getRange(r + 2, col['Used'] + 1).setValue('Yes');
      if (col['First used on'] !== undefined) {
        var cell = sheet.getRange(r + 2, col['First used on'] + 1);
        if (!cell.getValue()) cell.setValue(safe(String(body.at || '').slice(0, 10)));
      }
      return { ok: true, found: true };
    }
    return { ok: true, found: false };
  } finally {
    lock.releaseLock();
  }
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
  if (body.action === 'stats') return reply(stats());
  if (body.action === 'set-status') return reply(setStatus(body.rows, body.status));
  if (body.action === 'beta-claim') return reply(betaClaim(body));
  if (body.action === 'beta-used') return reply(betaUsed(body));

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
    // Keep row 1 in step with HEADERS (also rewrites an older header layout).
    ensureHeader(sheet);
    sheet.appendRow([
      safe(body.receivedAt),
      rating,
      safe(body.subject),
      safe(body.details),
      snapshotUrl,
      safe(body.trigger),
      safe(body.action),
      safe(body.pageUrl),
      safe(body.site),
      safe(body.wallet),
      safe(body.userAgent),
      safe(body.id),
      '',
    ]);
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true, snapshotUrl: snapshotUrl });
}
