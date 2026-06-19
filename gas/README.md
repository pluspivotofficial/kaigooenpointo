# GAS 集計層（応募ダッシュボード）

設計書: [`../docs/dashboard-redesign.md`](../docs/dashboard-redesign.md)
構成: **案1（静的フロント + GAS は JSON API）**

```
各ソースのフォルダ(最新CSV) + マスタ2枚 ──(毎日トリガー)──▶ runDailyAggregation()
        │  突合・オフィス振り分け・集計
        ▼
   {month}_summary.json（Cache + Drive）
        ▲
   doGet() が返すだけ ──fetch──▶ dashboard/index.html（GitHub Pages）
```

## 実データの構成（CONFIG に設定済み）
| 用途 | 実体 | 文字コード | フォルダ/シートID |
|------|------|-----------|------------------|
| 総応募(①) | 「+ホップ 集客DB - 統合ツールデータ」CSV | UTF-8 | `1VvdyRw6Fd2ox-GWQXMhSsapROLNFNbEC` |
| MCG人選(⑤) | 「+ホップ 集客DB - シート4」CSV（接触/歩留/人選を含む） | UTF-8 | `12GI5yYIje9h8YOetRJs3R20olCn5fe2e` |
| MCG稼働(③) | 「【真子】集客項目出力…」CSV | Shift_JIS | `1CsO0ATFsQCKMZBmGSLP6lVdbxhH2ng3E`（現状未使用） |
| 対応表 | スプレッドシート（列: `都道府県`/`オフィス`） | – | `1quGDrLDXBkJ4iVO0dUhkGtbqAvs8_QRSaZHRXeAiJK4` |
| 目標 | スプレッドシート（列: `オフィス`/`目標`） | – | `1pd3HgF5zE8Njd7SLQZqTvbzyGMGtlIMhOAfUV7Sl7dY` |
| 出力 | `{month}_summary.json` | – | 親 `1B-WC1fRgXnYAhfAvxx3fGGXROqodB9vD` |

> 接触/歩留/人選は **⑤(UTF-8) 1ファイル** から集計（全列を含むため）。
> ③(Shift_JIS) は電話応募の取り込みが必要になった場合に使用（現状は未使用）。

## セットアップ手順
1. [script.google.com](https://script.google.com) で新規プロジェクト → `Code.gs` / `appsscript.json` を貼り付け。
2. メニューで `runForMay2026` を実行（データのある 2026-05 で動作確認）→ 権限承認。
3. ログ（offices / dailyPoints）と、親フォルダに `2026-05_summary.json` ができることを確認。
4. `installDailyTrigger` を実行 → 毎朝6時の自動集計を登録。
5. 「デプロイ > 新しいデプロイ > ウェブアプリ」: アクセス=全員。発行URLを控える。
6. `dashboard/index.html` の `API_URL` にそのURLを設定（フロント接続）。

## 確定した集計ルール
1. **新規/再応募** … 総応募は累積スプレッドシート（`TOTAL_SHEET_ID`、全履歴）。応募日昇順で**電話番号の初出=新規 / 以降=再応募**（重複応募・有効応募列は不使用）。再応募は電話でユニーク化。**日次グラフの再応募も電話ユニーク**（各人を月内最初の再応募日に1計上）。
2. **電話応募** … MCG(⑤)にあり総応募に無い電話＝電話応募。新規に加算し `phoneApplications` に内訳化。
3. **接触/人選** … 当月応募分（応募日基準）で集計。
4. **歩留** … 各ステージの日付列が**当月**のものをカウント。コホートは初回応募日で判定（当月内 ⊂ 2ヶ月以内）。
5. **人選判定** … ⑤を**GASで4条件判定**（列インデックス参照）。有資格(福祉資格に「有資格」)／介護経験=有／勤務日数に「LT」／年齢60未満 の該当数で **4=A・3=B・2=C・0-1=その他**。

## 総応募シートへのCSV追記（自動）
- `runDailyAggregation` の冒頭で `appendLatestTotalCsv()` を自動実行（毎日トリガーに同梱）。
- `appendLatestTotalCsv()` … `TOTAL_FOLDER_ID` の最新CSVを `TOTAL_SHEET_ID` の末尾へ追記（列名マッピング・二重追記防止）。
- **自動化を有効にする前に一度だけ `markLatestCsvProcessed()` を実行**：現在フォルダにある古いCSV（既にシート取込済み）を「追記済み」として記録し、二重追記を防ぐ。
- 以後は応募ツールが新しいCSVをフォルダに吐けば、翌朝の集計時に自動追記される。

## 出力JSON
設計書セクション5のスキーマと同一。`dashboard/index.html` の `SAMPLE_DATA` が参照例。
