# GAS 集計層（応募ダッシュボード）

設計書: [`../docs/dashboard-redesign.md`](../docs/dashboard-redesign.md)
構成: **案1（静的フロント + GAS は JSON API）**

```
Driveの各CSV/マスタ ──(毎日トリガー)──▶ runDailyAggregation()
        │  突合・オフィス振り分け・集計
        ▼
   summary.json（Cache + Drive）
        ▲
   doGet() が返すだけ ──fetch──▶ dashboard/index.html（GitHub Pages）
```

## ファイル
- `Code.gs` … 集計ロジック・`doGet`・トリガー
- `appsscript.json` … マニフェスト（Webアプリ=匿名公開・JST）

## セットアップ手順
1. [script.google.com](https://script.google.com) で新規プロジェクトを作成し、`Code.gs` / `appsscript.json` を貼り付け。
2. データ用フォルダを作成し、各CSV・マスタを配置（命名は `CONFIG.FILE_PATTERN_*` に合わせる）。
3. `CONFIG` を実環境に合わせて設定:
   - `DATA_FOLDER_ID` / `OUTPUT_FOLDER_ID`
   - `PREF_OFFICE_SHEET_ID`（都道府県↔オフィス対応表）, `TARGET_SHEET_ID`（目標マスタ）
   - `CSV_CHARSET`（MCGがShift_JISなら `'Shift_JIS'`）
4. `COL`（各CSVの列名）を実際のヘッダーに合わせて調整。
5. メニューで `runDailyAggregation` を一度手動実行 → 権限承認 → 動作確認。
6. `installDailyTrigger` を一度実行 → 毎朝6時の自動集計を登録。
7. 「デプロイ > 新しいデプロイ > ウェブアプリ」: アクセス=全員。発行URLを控える。
8. `dashboard/index.html` の `API_URL` にそのURLを設定（フロント接続）。

## マスタの想定列
- 対応表シート: `都道府県`, `オフィス名`
- 目標シート: `対象月`(任意, 例 `2026-06`), `オフィス名`, `目標新規`

## 実装時に確認が必要な点（コード内 ▼TODO/▼要確認）
- 各CSVの**実ヘッダー名**（`COL` を合わせる）
- 電話のみ応募（総応募CSVに無い）の**新規/再応募の判定ルール** … `inferKindForPhoneOnly_()`
- MCGで**電話応募を示す列・値** … `COL.mcg.channel` / `PHONE_CHANNELS`
- `reAB`（再応募のA+B参考値）を**ユニーク化**するか件数ベースか
- 接触ステータス・人選判定の**表記ゆれ**（全角/半角・前後空白）

## 出力JSON
設計書セクション5のスキーマと同一。`dashboard/index.html` の `SAMPLE_DATA` がそのまま参照例。
