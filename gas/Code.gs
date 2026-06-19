/**
 * 介護職応援ポイント 応募ダッシュボード — GAS 集計層
 * 設計書: docs/dashboard-redesign.md
 *
 * 役割:
 *   1) runDailyAggregation() : 毎日1回、各フォルダの最新CSV/マスタを突合して
 *      集計済みサマリーJSONを生成し、CacheService + Drive(summary.json) に保存。
 *   2) doGet()               : 保存済みサマリーJSONを返すだけの薄いAPI。
 *   3) installDailyTrigger() : 毎日トリガーを登録（最初に1回だけ実行）。
 *
 * 実データのフォルダ/ファイル構成（2026-06 時点）:
 *   総応募データ        … 「+ホップ 集客DB - 統合ツールデータ」CSV (UTF-8)
 *   MCG稼働データ(③)    … 「【真子】集客項目出力…」CSV (Shift_JIS)  ※現状は未使用
 *   MCG人選データ(⑤)    … 「+ホップ 集客DB - シート4」CSV (UTF-8)
 *       └ 接触ステータス・歩留（新規）列・人選ｽﾃｰﾀｽ・都道府県を全て含むため、
 *         接触/歩留/人選はこの1ファイルから集計する。
 *
 * ▼要確認（コード内 TODO）:
 *   - 新規/再応募の判定ルール（重複応募・有効応募の解釈）… resolveKind_()
 *   - 電話応募（総応募CSVに無い）の取り込み … MCG稼働データ(③)の利用要否
 */

/* =========================================================================
 * 設定（フォルダ/シートのIDは実環境のもの）
 * ========================================================================= */
const CONFIG = {
  // 各ソースのフォルダID（中の「最新更新CSV」を読む）
  TOTAL_FOLDER_ID: '1VvdyRw6Fd2ox-GWQXMhSsapROLNFNbEC',      // 総応募データ
  SELECTION_FOLDER_ID: '12GI5yYIje9h8YOetRJs3R20olCn5fe2e',  // MCG人選データ(⑤) 接触/歩留/人選
  MCG_FOLDER_ID: '1CsO0ATFsQCKMZBmGSLP6lVdbxhH2ng3E',        // MCG稼働データ(③) ※電話応募取込み用(予約)

  // 出力（summary.json の置き場所。親フォルダに出力）
  OUTPUT_FOLDER_ID: '1B-WC1fRgXnYAhfAvxx3fGGXROqodB9vD',
  SUMMARY_FILENAME: 'summary.json',

  // マスタ（スプレッドシート）
  PREF_OFFICE_SHEET_ID: '1quGDrLDXBkJ4iVO0dUhkGtbqAvs8_QRSaZHRXeAiJK4', // 都道府県↔オフィス
  TARGET_SHEET_ID: '1pd3HgF5zE8Njd7SLQZqTvbzyGMGtlIMhOAfUV7Sl7dY',     // オフィス別目標

  // 文字コード（ソース別）
  CHARSET_TOTAL: 'UTF-8',
  CHARSET_SELECTION: 'UTF-8',
  CHARSET_MCG: 'Shift_JIS',

  CACHE_KEY: 'dashboard_summary_v1',
  CACHE_TTL_SEC: 21600, // 6時間
  TZ: 'Asia/Tokyo',
};

// 列名（実ヘッダーに準拠）
const COL = {
  total: {  // 総応募（統合ツールデータ）
    applyDate: '（応募内容）応募日',
    phone: '連絡先TEL',
    office: '拠点',
    pref: '都道府県名',
    media: '媒体',
    dup: '重複応募',     // 同一人物の応募回数（≦1=新規 / ≧2=再応募）。有効応募列は不使用
  },
  mcg: {    // MCG人選データ(⑤)（接触/歩留/人選）
    phone: '電話番号',
    pref: '都道府県',
    applyDate: '応募日',
    contactStatus: '接触ステータス',
    media: '応募媒体',
    setNew: '設定日（新規）',
    doneNew: '実施日（新規）',
    decNew: '決定日（新規）',
    startNew: '開始日（新規）',
    judge: '人選ｽﾃｰﾀｽ',   // 例: A人選（★★★★） / その他 / 空=不明
  },
};

const CONTACT_PREFIX = '接触'; // 接触 (電話)/(フォーム)/(メール) を前方一致で判定
const FUNNEL_STAGES = [
  ['set', 'setNew'],
  ['done', 'doneNew'],
  ['decided', 'decNew'],
  ['started', 'startNew'],
];

/* =========================================================================
 * Web API
 * ========================================================================= */
function doGet(e) {
  const month = (e && e.parameter && e.parameter.month) || currentMonthKey_();
  let json = CacheService.getScriptCache().get(CONFIG.CACHE_KEY + ':' + month);
  if (!json) json = readSummaryFromDrive_(month);
  if (!json) json = JSON.stringify({ error: 'summary not generated yet', month: month });
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 * メイン: 毎日の事前集計
 * ========================================================================= */
function runDailyAggregation(monthArg) {
  const month = monthArg || currentMonthKey_();

  // --- マスタ ---
  const prefToOffice = loadPrefToOffice_();          // { '東京都':'新宿オフィス', ... }
  const officePrefs = invertPrefMap_(prefToOffice);  // { '新宿オフィス':['東京都','埼玉県',...] }
  const targets = loadTargets_();                     // { '新宿オフィス':120, ... }

  // --- 入力CSV（各フォルダの最新） ---
  const totalRows = readLatestCsv_(CONFIG.TOTAL_FOLDER_ID, CONFIG.CHARSET_TOTAL);
  const mcgRows = readLatestCsv_(CONFIG.SELECTION_FOLDER_ID, CONFIG.CHARSET_SELECTION); // ⑤

  const kindByPhone = {};        // 電話 → 'new' | 're'（総応募由来）
  const totalPhoneSet = {};      // 総応募に存在する電話（電話応募判定用）
  const judgeByPhone = {};       // 電話 → 'A'|'B'|'C'|'other'|'unknown'（⑤由来）
  const dailyMap = {};
  const range = monthRange_(month);

  // --- オフィス集計器（マスタ基準で初期化） ---
  const acc = {};
  Object.keys(officePrefs).forEach(office => {
    acc[office] = newOfficeAcc_(office, officePrefs[office], targets[office] || 0);
  });

  // 人選参照表
  mcgRows.forEach(r => { judgeByPhone[normPhone_(r[COL.mcg.phone])] = judgeLetter_(r[COL.mcg.judge]); });
  // 総応募の電話一覧（全行・全期間）
  totalRows.forEach(r => { const p = normPhone_(r[COL.total.phone]); if (p) totalPhoneSet[p] = true; });

  // --- ① 総応募: 新規/再応募・A+B参考値・日次（重複応募で区分。有効応募は不使用） ---
  const reUniqByOffice = {};
  totalRows.forEach(r => {
    const office = r[COL.total.office] || prefToOffice[(r[COL.total.pref] || '').trim()];
    if (!office || !acc[office]) return;
    const phone = normPhone_(r[COL.total.phone]);
    const kind = resolveKind_(r);                   // 'new' | 're'
    kindByPhone[phone] = kind;
    const d = parseDate_(r[COL.total.applyDate]);
    if (!inRange_(d, range.monthStart, range.monthEnd)) return;
    const ab = judgeByPhone[phone] === 'A' || judgeByPhone[phone] === 'B';

    if (kind === 'new') {
      acc[office].overview.newApplications += 1;
      if (ab) acc[office].overview.newAB += 1;
    } else {
      reUniqByOffice[office] = reUniqByOffice[office] || new Set();
      if (phone) reUniqByOffice[office].add(phone);   // 再応募は電話でユニーク
      if (ab) acc[office].overview.reAB += 1;
    }
    const key = fmtDate_(d);
    dailyMap[key] = dailyMap[key] || { new: 0, re: 0 };
    if (kind === 'new') dailyMap[key].new += 1; else dailyMap[key].re += 1;
  });
  Object.keys(reUniqByOffice).forEach(o => { acc[o].overview.reApplications = reUniqByOffice[o].size; });

  // --- ⑤ MCG人選: 電話応募・接触数・歩留・人選 ---
  const phoneAppSeen = {};       // office → Set(電話)：電話応募のユニーク化
  mcgRows.forEach(r => {
    const office = prefToOffice[(r[COL.mcg.pref] || '').trim()];
    if (!office || !acc[office]) return;
    const phone = normPhone_(r[COL.mcg.phone]);
    const d = parseDate_(r[COL.mcg.applyDate]);
    const inMonth = inRange_(d, range.monthStart, range.monthEnd);
    const letter = judgeLetter_(r[COL.mcg.judge]);

    // 電話応募 = MCGにあり総応募に無い電話（当月・電話でユニーク）→ 新規に加算
    if (inMonth && phone && !totalPhoneSet[phone]) {
      const seen = phoneAppSeen[office] || (phoneAppSeen[office] = {});
      if (!seen[phone]) {
        seen[phone] = true;
        acc[office].overview.phoneApplications += 1;
        acc[office].overview.newApplications += 1;
        if (letter === 'A' || letter === 'B') acc[office].overview.newAB += 1;
        kindByPhone[phone] = 'new'; // 歩留でも新規扱い
      }
    }

    // 接触数（当月応募）
    if (inMonth && (r[COL.mcg.contactStatus] || '').trim().indexOf(CONTACT_PREFIX) === 0) {
      acc[office].overview.contacts += 1;
    }

    // 人選（当月応募・A/B/C/その他/不明）
    if (inMonth) bumpSelection_(acc[office].selection, letter);

    // 歩留（全コホート（新規）列のみ。区分は総応募/電話応募由来）
    const cohort = funnelCohort_(kindByPhone[phone], d, range);
    if (cohort) {
      const f = acc[office].funnel[cohort];
      FUNNEL_STAGES.forEach(([outKey, colKey]) => { if (notEmpty_(r[COL.mcg[colKey]])) f[outKey] += 1; });
      if (letter === 'A' || letter === 'B') f._abPhones.add(phone || Math.random());
    }
  });

  // --- 仕上げ ---
  const elapsed = elapsedDays_(month), totalDays = daysInMonth_(month);
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
    offices: Object.values(acc).filter(hasAnyData_),
  };

  saveSummary_(month, JSON.stringify(summary));
  Logger.log('aggregated %s: offices=%s, dailyPoints=%s', month, summary.offices.length, daily.length);
  return summary;
}

/* 手元確認用: データのある月（例 2026-05）で実行 */
function runForMay2026() { return runDailyAggregation('2026-05'); }

/* =========================================================================
 * 区分・人選の判定
 * ========================================================================= */
// 新規/再応募の判定: 重複応募≦1=新規 / ≧2=再応募（有効応募は不使用）
function resolveKind_(r) {
  const dup = Number((r[COL.total.dup] || '').toString().trim()) || 0;
  return dup <= 1 ? 'new' : 're';
}

// 人選ｽﾃｰﾀｽ文字列 → 'A'|'B'|'C'|'other'|'unknown'
function judgeLetter_(v) {
  const s = (v || '').toString().trim();
  if (!s) return 'unknown';
  if (s.indexOf('A人選') === 0) return 'A';
  if (s.indexOf('B人選') === 0) return 'B';
  if (s.indexOf('C人選') === 0) return 'C';
  if (s.indexOf('その他') === 0) return 'other';
  if (s.indexOf('不明') === 0) return 'unknown';
  return 'other';
}

function bumpSelection_(sel, letter) {
  if (letter === 'A') sel.A += 1;
  else if (letter === 'B') sel.B += 1;
  else if (letter === 'C') sel.C += 1;
  else if (letter === 'other') sel.other += 1;
  else sel.unknown += 1;
}

function funnelCohort_(kind, d, range) {
  if (kind === 're') return 'reApplication';
  if (kind === 'new') {
    if (inRange_(d, range.monthStart, range.monthEnd)) return 'currentMonthNew';
    if (inRange_(d, range.twoMonthStart, range.monthEnd)) return 'within2MonthsNew';
  }
  return null;
}

/* =========================================================================
 * 集計器
 * ========================================================================= */
function newOfficeAcc_(office, prefs, target) {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    office: office,
    prefectures: prefs,
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, targetNew: target, forecast: 0, contacts: 0, newAB: 0, reAB: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
  };
}

function hasAnyData_(o) {
  const v = o.overview;
  const sel = Object.values(o.selection).reduce((a, b) => a + b, 0);
  return v.newApplications || v.reApplications || v.contacts || v.targetNew || sel;
}

/* =========================================================================
 * マスタ
 * ========================================================================= */
function loadPrefToOffice_() {
  const rows = readSheetObjects_(CONFIG.PREF_OFFICE_SHEET_ID);
  const map = {};
  rows.forEach(r => {
    const pref = (r['都道府県'] || '').toString().trim();
    const office = (r['オフィス'] || r['オフィス名'] || '').toString().trim();
    if (pref && office) map[pref] = office;
  });
  return map;
}

function loadTargets_() {
  const rows = readSheetObjects_(CONFIG.TARGET_SHEET_ID);
  const map = {};
  rows.forEach(r => {
    const office = (r['オフィス'] || r['オフィス名'] || '').toString().trim();
    const t = Number(r['目標'] || r['目標新規'] || 0);
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
 * I/O
 * ========================================================================= */
function readLatestCsv_(folderId, charset) {
  const files = DriveApp.getFolderById(folderId).getFiles();
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) { Logger.log('CSV not found in folder ' + folderId); return []; }
  return csvToObjects_(best.getBlob().getDataAsString(charset || 'UTF-8'));
}

function csvToObjects_(text) {
  const data = Utilities.parseCsv(text);
  if (!data || data.length < 2) return [];
  const header = data[0].map(h => (h || '').trim());
  return data.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (o[h] === undefined) o[h] = row[i]; }); // 重複ヘッダーは先頭優先
    return o;
  });
}

function readSheetObjects_(sheetId) {
  const sh = SpreadsheetApp.openById(sheetId).getSheets()[0];
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
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(json);
  else folder.createFile(name, json, 'application/json');
}

function readSummaryFromDrive_(month) {
  const it = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID).getFilesByName(month + '_' + CONFIG.SUMMARY_FILENAME);
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* =========================================================================
 * 日付・文字列
 * ========================================================================= */
function currentMonthKey_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM'); }

function monthRange_(month) {
  const [y, m] = month.split('-').map(Number);
  return {
    monthStart: new Date(y, m - 1, 1),
    monthEnd: new Date(y, m, 0, 23, 59, 59),
    twoMonthStart: new Date(y, m - 2, 1), // 当月含む直近2ヶ月＝前月1日〜当月末
  };
}

function daysInMonth_(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }

function elapsedDays_(month) {
  const now = new Date();
  if (Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM') !== month) return daysInMonth_(month);
  return Number(Utilities.formatDate(now, CONFIG.TZ, 'd'));
}

function parseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = v.toString().trim().replace(/\//g, '-');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate_(d) { return d ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd') : ''; }
function inRange_(d, a, b) { return !!d && d >= a && d <= b; }
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
