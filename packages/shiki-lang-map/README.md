# @gozd/shiki-lang-map

ファイル拡張子 / ファイル名 → Shiki `BundledLanguage` の対応表。GitHub Linguist
の `languages.yml` (= 業界 de facto SSOT) を Shiki の bundled language IDs で
filter / 変換した静的マップを提供する。

## なぜこの package があるか

Shiki は「ファイル拡張子からの言語検出」を提供しない (lang ID を呼び出し側で
指定する API 契約)。一方アプリ側はファイルパスから言語を決めたい。両者の橋渡しを
する責務をここに閉じる。

データ SSOT を 1 箇所に固定し、手書きの拡張子テーブルを各 feature が持たないように
している。

## 構成

```text
packages/shiki-lang-map/
├── dist/                              # 生成物 (.gitignore 対象)
│   └── extensionLangMap.generated.ts  # ext / filename → BundledLanguage の静的マップ
├── scripts/
│   └── generateExtensionLangMap.ts    # dist/extensionLangMap.generated.ts を生成
└── src/
    └── index.ts                       # バレル
```

## 公開 API

- `LINGUIST_EXTENSION_LANG_MAP` — 拡張子 (例: `ts`, `swift`, `proto`) → `BundledLanguage`
- `LINGUIST_FILENAME_LANG_MAP` — ファイル名 (例: `Dockerfile`, `Makefile`) → `BundledLanguage`

両テーブルとも `Record<string, BundledLanguage>` に satisfies されており、型レベルで
Shiki bundle に存在する言語であることが保証される。

## 生成ロジック

`pnpm install` 時に `prepare` で `bun scripts/generateExtensionLangMap.ts` が走り、
以下を実行する:

- `linguist-languages` の全 language entry を列挙
- 各 language の `name` / `aliases` を Shiki の `bundledLanguagesInfo` の `id` / `aliases` と
  照合 (lowercase 一致 / 空白 → hyphen / NAME_TO_SHIKI 明示 alias table の順)
- Shiki にも存在する言語のみを残し、その `extensions` / `filenames` を Shiki id にマップする
- 多重所属する拡張子 (例: `.m` が Objective-C と MATLAB 両方に居る) は Linguist の
  language 名 ASCII 順で **first-write-wins** する。これと違う policy が必要な
  consumer は自前の override 層を被せる (例: `apps/renderer/src/features/preview/useHighlight.ts`)

Linguist の disambiguation 用 heuristics (content-based regex) は実装しない。
拡張子だけでは決まらない曖昧性は consumer 側 override で吸収する設計。

## 更新

`linguist-languages` を bump して `pnpm install` を再実行すれば `dist/` が再生成される。
