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
 *   - 新規/再応募は累積シート内で電話番号の初出判定（初出=新規 / 以降=再応募）
 *   - 電話応募 = MCG(⑤)にあり総応募に無い電話。新規に加算し phoneApplications に内訳化
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
    // 新規/再応募は重複応募列に頼らず、電話番号の初出で判定（累積シート内で重複判定）
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

  const totalPhoneSet = {};      // 総応募に存在する電話（電話応募判定用）
  const firstDateByPhone = {};   // 電話 → 初回応募日（累積シートでの重複判定）
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

  // --- 重複判定: 累積シートを応募日昇順に走査し、電話の初出=新規・以降=再応募 ---
  const parsed = totalRows.map(r => ({
    office: r[COL.total.office] || prefToOffice[(r[COL.total.pref] || '').trim()],
    phone: normPhone_(r[COL.total.phone]),
    d: parseDate_(r[COL.total.applyDate]),
  })).filter(x => x.d);
  parsed.sort((a, b) => a.d - b.d);
  parsed.forEach(x => {
    if (x.phone) {
      totalPhoneSet[x.phone] = true;
      x.first = !firstDateByPhone[x.phone];          // この電話の初回行か（=新規=1 / 再応募=0）
      if (x.first) firstDateByPhone[x.phone] = x.d;
    } else { x.first = true; }
  });

  // --- ① 総応募: 当月の新規/再応募・A+B参考値・日次 ---
  const reUniqByOffice = {};
  parsed.forEach(x => {
    if (!x.office || !acc[x.office] || !inRange_(x.d, range.monthStart, range.monthEnd)) return;
    const ab = judgeByPhone[x.phone] === 'A' || judgeByPhone[x.phone] === 'B';
    if (x.first) {                                    // 初回=新規
      acc[x.office].overview.newApplications += 1;
      if (ab) acc[x.office].overview.newAB += 1;
    } else {                                          // 2回目以降=再応募（電話でユニーク）
      reUniqByOffice[x.office] = reUniqByOffice[x.office] || new Set();
      if (x.phone) reUniqByOffice[x.office].add(x.phone);
      if (ab) acc[x.office].overview.reAB += 1;
    }
    const key = fmtDate_(x.d);
    dailyMap[key] = dailyMap[key] || { new: 0, re: 0 };
    if (x.first) dailyMap[key].new += 1; else dailyMap[key].re += 1;
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
        firstDateByPhone[phone] = d; // 歩留でも当月の新規扱い
      }
    }

    // 接触数（当月応募）
    if (inMonth && (r[COL.mcg.contactStatus] || '').trim().indexOf(CONTACT_PREFIX) === 0) {
      acc[office].overview.contacts += 1;
    }

    // 人選（当月応募・A/B/C/その他/不明）
    if (inMonth) bumpSelection_(acc[office].selection, letter);

    // 歩留: コホート(初回応募日で判定) × 各ステージ「日付列が当月のもの」をカウント
    // 当月内応募・新規 ⊂ 2ヶ月以内応募・新規（当月含む直近2ヶ月）なので両方に加算しうる。
    const fd = firstDateByPhone[phone];   // 初回応募日（新規＝今月初出 / 再応募＝今月より前に初出）
    const cohorts = [];
    if (fd) {
      if (inRange_(fd, range.monthStart, range.monthEnd)) cohorts.push('currentMonthNew');
      if (inRange_(fd, range.twoMonthStart, range.monthEnd)) cohorts.push('within2MonthsNew');
      if (fd < range.monthStart) cohorts.push('reApplication');
    }
    cohorts.forEach(c => {
      const f = acc[office].funnel[c];
      FUNNEL_STAGES.forEach(([outKey, colKey]) => {
        const sd = parseDate_(r[COL.mcg[colKey]]);
        if (inRange_(sd, range.monthStart, range.monthEnd)) f[outKey] += 1; // その日付が当月
      });
      if (letter === 'A' || letter === 'B') f._abPhones.add(phone || Math.random());
    });
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
  const sampleHeaders = totalRows[0] ? Object.keys(totalRows[0]).slice(0, 4).join(' | ') : '(none)';
  Logger.log('aggregated %s: offices=%s, dailyPoints=%s | totalRows=%s, mcgRows=%s, prefMap=%s, parsedInRange=%s | totalHeaders[0..3]=%s',
    month, summary.offices.length, daily.length,
    totalRows.length, mcgRows.length, Object.keys(prefToOffice).length,
    parsed.filter(x => inRange_(x.d, range.monthStart, range.monthEnd)).length, sampleHeaders);
  return summary;
}

/* 手元確認用: データのある月（例 2026-05）で実行 */
function runForMay2026() { return runDailyAggregation('2026-05'); }

/* =========================================================================
 * 区分・人選の判定
 * ========================================================================= */
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
// 対応表: A列=都道府県, B列=オフィス（列位置で読む。ヘッダー行はスキップ）
function loadPrefToOffice_() {
  const vals = readSheetMatrix_(CONFIG.PREF_OFFICE_SHEET_ID);
  const map = {};
  vals.forEach(row => {
    const pref = (row[0] || '').toString().trim();
    const office = (row[1] || '').toString().trim();
    if (pref && office && pref !== '都道府県') map[pref] = office;
  });
  return map;
}

// 目標: A列=オフィス, B列=目標
function loadTargets_() {
  const vals = readSheetMatrix_(CONFIG.TARGET_SHEET_ID);
  const map = {};
  vals.forEach(row => {
    const office = (row[0] || '').toString().trim();
    const t = Number(row[1] || 0);
    if (office && office !== 'オフィス') map[office] = t;
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
  const clean = (text || '').replace(/^﻿/, ''); // 先頭BOM除去
  const data = Utilities.parseCsv(clean);
  if (!data || data.length < 2) return [];
  const header = data[0].map(h => (h || '').replace(/^﻿/, '').trim());
  return data.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (o[h] === undefined) o[h] = row[i]; }); // 重複ヘッダーは先頭優先
    return o;
  });
}

function readSheetMatrix_(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sh = ss.getSheets()[0];
  const vals = sh.getDataRange().getValues();
  Logger.log('master "%s" sheet="%s" rows=%s row0=%s row1=%s',
    ss.getName(), sh.getName(), vals.length, JSON.stringify(vals[0]), JSON.stringify(vals[1]));
  return vals;
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
  const m = v.toString().match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); // 年月日（ゼロ詰め有無・時刻付き対応）
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
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
