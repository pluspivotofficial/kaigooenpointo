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

## ▼要確認（業務ルール / コード内TODO）
1. **新規/再応募の判定** … 現状 `resolveKind_()` は「重複応募≦1=新規・2以上=再応募／有効応募=1のみ集計」。
   - 総応募CSVに区分列が無く、`重複応募`(回数) と `有効応募`(0/1) のみのため暫定実装。解釈が違えばここを直す。
2. **電話応募の取り込み** … 電話応募は総応募CSVに無い。MCG稼働(③)から「電話由来の新規」を加える場合のキー列/値。
3. **人選の表記** … `A人選（★★★★）`等は前方一致で判定。空欄=不明として扱う。

## 出力JSON
設計書セクション5のスキーマと同一。`dashboard/index.html` の `SAMPLE_DATA` が参照例。
