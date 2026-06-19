/**
 * 介護職応援ポイント 応募ダッシュボード — GAS 集計層（雛形）
 * 設計書: docs/dashboard-redesign.md
 *
 * 役割:
 *   1) runDailyAggregation() : 毎日1回、Driveフォルダの各CSV/マスタを突合して
 *      集計済みサマリーJSONを生成し、CacheService + Drive(summary.json) に保存。
 *   2) doGet()               : 保存済みサマリーJSONを返すだけの薄いAPI。
 *   3) installDailyTrigger() : 毎日トリガーを登録（最初に1回だけ実行）。
 *
 * ※ ▼TODO/▼要確認 の箇所は、実データのヘッダー名・配置に合わせて調整してください。
 *   フロント(dashboard/index.html)が消費するJSONスキーマは設計書セクション5と同一。
 */

/* =========================================================================
 * 設定（ここだけ環境に合わせて書き換える）
 * ========================================================================= */
const CONFIG = {
  // 各CSVを置く Driveフォルダ（このGoogleアカウント内に作成予定のフォルダID）
  DATA_FOLDER_ID: 'PUT_DATA_FOLDER_ID',
  // summary.json の出力先（同じフォルダでも可）
  OUTPUT_FOLDER_ID: 'PUT_OUTPUT_FOLDER_ID',
  SUMMARY_FILENAME: 'summary.json',

  // マスタ（スプレッドシート）
  PREF_OFFICE_SHEET_ID: 'PUT_PREF_OFFICE_SHEET_ID',  // 都道府県↔オフィス 対応表
  PREF_OFFICE_SHEET_NAME: '対応表',
  TARGET_SHEET_ID: 'PUT_TARGET_SHEET_ID',            // オフィス別 目標マスタ
  TARGET_SHEET_NAME: '目標',

  // フォルダ内のファイル名パターン（最新更新分を採用）
  FILE_PATTERN_TOTAL: /総応募|obo|integrated/i,   // ① obo-data-tool 統合CSV（新規/再応募の区分つき）
  FILE_PATTERN_MCG: /mcg(?!.*人選)/i,             // ③ MCG 全CSV（接触・歩留）
  FILE_PATTERN_SELECTION: /人選|selection/i,      // ⑤ 人選入り MCG データ

  // CSV文字コード（MCG等がShift_JISの場合は 'Shift_JIS' に）
  CSV_CHARSET: 'UTF-8',

  CACHE_KEY: 'dashboard_summary_v1',
  CACHE_TTL_SEC: 21600, // 6時間
  TZ: 'Asia/Tokyo',
};

// 各ソースの列名（▼実ヘッダーに合わせて調整）
const COL = {
  total: {      // ① 総応募
    phone: '電話番号',
    office: 'オフィス名',
    pref: '都道府県',
    applyDate: '応募日',
    kind: '区分',        // 値: 新規 / 再応募
    media: '媒体',
  },
  mcg: {        // ③ MCG
    phone: '電話番号',
    pref: '都道府県',
    applyDate: '応募日',
    contactStatus: '接触ステータス',
    channel: '流入経路',          // 電話応募の判定用（▼要確認）
    setNew: '設定日（新規）',
    doneNew: '実施日（新規）',
    decNew: '決定日（新規）',
    startNew: '開始日（新規）',
  },
  selection: {  // ⑤ 人選入りMCG
    phone: '電話番号',
    pref: '都道府県',
    judge: '人選判定',   // 値: A / B / C / その他 / 不明 など
  },
};

const KIND_NEW = '新規';
const KIND_RE = '再応募';
const CONTACT_STATUSES = ['接触（電話）', '接触（フォーム）', '接触（メール）'];
const PHONE_CHANNELS = ['電話'];      // ▼要確認: MCGで電話応募を示す値
const AB_JUDGES = ['A', 'B'];
const FUNNEL_STAGES = [
  ['set', 'setNew'],
  ['done', 'doneNew'],
  ['decided', 'decNew'],
  ['started', 'startNew'],
];

/* =========================================================================
 * Web API: 保存済みサマリーを返すだけ（重い処理はしない）
 * ========================================================================= */
function doGet(e) {
  const month = (e && e.parameter && e.parameter.month) || currentMonthKey_();
  let json = CacheService.getScriptCache().get(CONFIG.CACHE_KEY + ':' + month);
  if (!json) {
    json = readSummaryFromDrive_(month); // キャッシュ切れ時はDriveの恒久版を返す
  }
  if (!json) {
    json = JSON.stringify({ error: 'summary not generated yet', month: month });
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 * メイン: 毎日の事前集計
 * ========================================================================= */
function runDailyAggregation() {
  const month = currentMonthKey_();

  // --- マスタ ---
  const prefToOffice = loadPrefToOffice_();      // { '東京都': '新宿オフィス', ... }
  const officePrefs = invertPrefMap_(prefToOffice); // { '新宿オフィス': ['東京都'], ... }
  const targets = loadTargets_(month);           // { '新宿オフィス': 60, ... }

  // --- 入力CSV ---
  const folder = DriveApp.getFolderById(CONFIG.DATA_FOLDER_ID);
  const totalRows = readLatestCsv_(folder, CONFIG.FILE_PATTERN_TOTAL);
  const mcgRows = readLatestCsv_(folder, CONFIG.FILE_PATTERN_MCG);
  const selRows = readLatestCsv_(folder, CONFIG.FILE_PATTERN_SELECTION);

  // 電話番号 → 区分 / 人選 の参照表
  const kindByPhone = {};
  totalRows.forEach(r => { kindByPhone[normPhone_(r[COL.total.phone])] = r[COL.total.kind]; });
  const judgeByPhone = {};
  selRows.forEach(r => { judgeByPhone[normPhone_(r[COL.selection.phone])] = (r[COL.selection.judge] || '').trim(); });

  // --- オフィスごとの集計器を初期化 ---
  const acc = {};
  Object.keys(officePrefs).forEach(office => {
    acc[office] = newOfficeAcc_(office, officePrefs[office], targets[office] || 0);
  });
  const officeOf = (pref, office) => office || prefToOffice[(pref || '').trim()] || null;

  // 当月／直近2ヶ月（当月含む）の範囲
  const range = monthRange_(month);

  // --- ① 総応募: 新規/再応募・A+B参考値・日次 ---
  const reUniqByOffice = {};            // 再応募の電話ユニーク化用 Set
  const dailyMap = {};                  // 日次 全体
  totalRows.forEach(r => {
    const office = officeOf(r[COL.total.pref], r[COL.total.office]);
    if (!office || !acc[office]) return;
    const phone = normPhone_(r[COL.total.phone]);
    const kind = (r[COL.total.kind] || '').trim();
    const d = parseDate_(r[COL.total.applyDate]);
    const inMonth = d && d >= range.monthStart && d <= range.monthEnd;
    const judgeAB = AB_JUDGES.indexOf(judgeByPhone[phone]) >= 0;

    if (kind === KIND_NEW && inMonth) {
      acc[office].overview.newApplications += 1;     // Web新規
      if (judgeAB) acc[office].overview.newAB += 1;
    } else if (kind === KIND_RE && inMonth) {
      reUniqByOffice[office] = reUniqByOffice[office] || new Set();
      if (phone) reUniqByOffice[office].add(phone);  // 再応募は電話でユニーク
      if (judgeAB) acc[office].overview.reAB += 1;    // ▼参考値: ユニーク化要否は要相談
    }
    // 日次（全体・当月）
    if (inMonth && d) {
      const key = fmtDate_(d);
      dailyMap[key] = dailyMap[key] || { new: 0, re: 0 };
      if (kind === KIND_NEW) dailyMap[key].new += 1;
      else if (kind === KIND_RE) dailyMap[key].re += 1;
    }
  });
  Object.keys(reUniqByOffice).forEach(o => { acc[o].overview.reApplications = reUniqByOffice[o].size; });

  // --- ③ MCG: 電話新規・接触数・歩留 ---
  mcgRows.forEach(r => {
    const office = officeOf(r[COL.mcg.pref], null);
    if (!office || !acc[office]) return;
    const phone = normPhone_(r[COL.mcg.phone]);
    const d = parseDate_(r[COL.mcg.applyDate]);
    // 区分は総応募で判定（電話のみ応募は総応募に無い→ ▼要確認の補完ルール）
    const kind = kindByPhone[phone] || inferKindForPhoneOnly_(r);

    // 電話新規を新規応募数に加算
    if (kind === KIND_NEW && isPhoneChannel_(r) && inRange_(d, range.monthStart, range.monthEnd)) {
      acc[office].overview.newApplications += 1;
      if (AB_JUDGES.indexOf(judgeByPhone[phone]) >= 0) acc[office].overview.newAB += 1;
    }

    // 接触数
    if (CONTACT_STATUSES.indexOf((r[COL.mcg.contactStatus] || '').trim()) >= 0) {
      acc[office].overview.contacts += 1;
    }

    // 歩留（全コホート（新規）列のみ参照。新規/再応募は総応募の区分で振り分け）
    const cohort = funnelCohort_(kind, d, range);
    if (cohort) {
      const f = acc[office].funnel[cohort];
      FUNNEL_STAGES.forEach(([outKey, colKey]) => {
        if (notEmpty_(r[COL.mcg[colKey]])) f[outKey] += 1;
      });
      if (AB_JUDGES.indexOf(judgeByPhone[phone]) >= 0) f._abPhones.add(phone || Math.random());
    }
  });

  // --- ⑤ 人選: A/B/C/その他/不明 ---
  selRows.forEach(r => {
    const office = officeOf(r[COL.selection.pref], null);
    if (!office || !acc[office]) return;
    bumpSelection_(acc[office].selection, (r[COL.selection.judge] || '').trim());
  });

  // --- 仕上げ: 着地見込み / funnel.ab / daily 配列化 ---
  const elapsed = elapsedDays_(month);
  const totalDays = daysInMonth_(month);
  Object.values(acc).forEach(o => {
    o.overview.forecast = elapsed > 0
      ? Math.round(o.overview.newApplications / elapsed * totalDays)
      : o.overview.newApplications;
    Object.values(o.funnel).forEach(f => { f.ab = f._abPhones.size; delete f._abPhones; });
  });

  const daily = Object.keys(dailyMap).sort().map(k => ({
    date: k, new: dailyMap[k].new, re: dailyMap[k].re, total: dailyMap[k].new + dailyMap[k].re,
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    month: month,
    daily: daily,
    offices: Object.values(acc).map(stripInternal_),
  };

  saveSummary_(month, JSON.stringify(summary));
  return summary;
}

/* =========================================================================
 * 集計器・補助
 * ========================================================================= */
function newOfficeAcc_(office, prefs, target) {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    office: office,
    prefectures: prefs,
    overview: { newApplications: 0, reApplications: 0, targetNew: target, forecast: 0, contacts: 0, newAB: 0, reAB: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
  };
}

function bumpSelection_(sel, judge) {
  if (judge === 'A') sel.A += 1;
  else if (judge === 'B') sel.B += 1;
  else if (judge === 'C') sel.C += 1;
  else if (!judge || judge === '不明') sel.unknown += 1;
  else sel.other += 1;
}

// 歩留コホート判定（新規/再応募とも（新規）列を見る。区分は総応募由来）
function funnelCohort_(kind, d, range) {
  if (kind === KIND_RE) return 'reApplication';
  if (kind === KIND_NEW) {
    if (inRange_(d, range.monthStart, range.monthEnd)) return 'currentMonthNew';
    if (inRange_(d, range.twoMonthStart, range.monthEnd)) return 'within2MonthsNew';
    // 当月コホートは2ヶ月コホートにも含める設計なら下行を有効化
    // （現状は応募日が当月→当月のみ、前月→2ヶ月のみ にカウント）
  }
  return null;
}

// 電話のみ応募（総応募に無い）の区分補完 — ▼要確認のルール
function inferKindForPhoneOnly_(r) {
  // 暫定: MCG側に区分列があればそれを使う / 無ければ新規扱い
  return KIND_NEW;
}

function isPhoneChannel_(r) {
  return PHONE_CHANNELS.indexOf((r[COL.mcg.channel] || '').trim()) >= 0;
}

function stripInternal_(o) {
  Object.values(o.funnel).forEach(f => { if (f._abPhones) delete f._abPhones; });
  return o;
}

/* =========================================================================
 * マスタ読み込み
 * ========================================================================= */
function loadPrefToOffice_() {
  const rows = readSheetObjects_(CONFIG.PREF_OFFICE_SHEET_ID, CONFIG.PREF_OFFICE_SHEET_NAME);
  const map = {};
  rows.forEach(r => {
    const pref = (r['都道府県'] || '').trim();
    const office = (r['オフィス名'] || '').trim();
    if (pref && office) map[pref] = office;
  });
  return map;
}

function loadTargets_(month) {
  const rows = readSheetObjects_(CONFIG.TARGET_SHEET_ID, CONFIG.TARGET_SHEET_NAME);
  const map = {};
  rows.forEach(r => {
    const m = (r['対象月'] || '').toString().trim();
    if (m && m !== month) return; // 対象月列があれば当月のみ
    const office = (r['オフィス名'] || '').trim();
    const t = Number(r['目標新規'] || 0);
    if (office) map[office] = t;
  });
  return map;
}

function invertPrefMap_(prefToOffice) {
  const out = {};
  Object.keys(prefToOffice).forEach(pref => {
    const office = prefToOffice[pref];
    (out[office] = out[office] || []).push(pref);
  });
  return out;
}

/* =========================================================================
 * I/O ユーティリティ
 * ========================================================================= */
function readLatestCsv_(folder, pattern) {
  const files = folder.getFiles();
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (pattern.test(f.getName()) && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) { Logger.log('CSV not found for ' + pattern); return []; }
  const text = best.getBlob().getDataAsString(CONFIG.CSV_CHARSET);
  return csvToObjects_(text);
}

function csvToObjects_(text) {
  const data = Utilities.parseCsv(text);
  if (!data || data.length < 2) return [];
  const header = data[0].map(h => (h || '').trim());
  return data.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { o[h] = row[i]; });
    return o;
  });
}

function readSheetObjects_(sheetId, sheetName) {
  const sh = SpreadsheetApp.openById(sheetId).getSheetByName(sheetName);
  if (!sh) { Logger.log('sheet not found: ' + sheetName); return []; }
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const header = data[0].map(h => (h || '').toString().trim());
  return data.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { o[h] = row[i]; });
    return o;
  });
}

function saveSummary_(month, json) {
  CacheService.getScriptCache().put(CONFIG.CACHE_KEY + ':' + month, json, CONFIG.CACHE_TTL_SEC);
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const name = month + '_' + CONFIG.SUMMARY_FILENAME;
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) existing.next().setContent(json);
  else folder.createFile(name, json, 'application/json');
}

function readSummaryFromDrive_(month) {
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const it = folder.getFilesByName(month + '_' + CONFIG.SUMMARY_FILENAME);
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* =========================================================================
 * 日付・文字列ヘルパー
 * ========================================================================= */
function currentMonthKey_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM'); }

function monthRange_(month) {
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59);
  const twoMonthStart = new Date(y, m - 2, 1); // 当月含む直近2ヶ月＝前月1日〜当月末
  return { monthStart, monthEnd, twoMonthStart };
}

function daysInMonth_(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }

function elapsedDays_(month) {
  const now = new Date();
  const nowKey = Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM');
  if (nowKey !== month) return daysInMonth_(month); // 過去月は満了
  return Number(Utilities.formatDate(now, CONFIG.TZ, 'd'));
}

function parseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = v.toString().trim().replace(/\//g, '-');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
function inRange_(d, a, b) { return d && d >= a && d <= b; }
function notEmpty_(v) { return v !== null && v !== undefined && v.toString().trim() !== ''; }
function normPhone_(v) { return (v || '').toString().replace(/[^0-9]/g, ''); }

/* =========================================================================
 * トリガー
 * ========================================================================= */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDailyAggregation') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyAggregation').timeBased().everyDays(1).atHour(6).create();
}
