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
  以下の順で照合する (`resolveShikiId`)
  - `NAME_TO_SHIKI` 明示 alias table (default rules で届かない pair だけを列挙)
  - lowercase 直接一致
  - 空白 → hyphen 正規化
  - Linguist 側 `aliases` を Shiki id / Shiki alias と突合
  - Shiki alias 直接一致
- Shiki にも存在する言語のみを残し、その `extensions` / `filenames` を Shiki id にマップする
- 多重所属する拡張子 (例: `.m` が Objective-C と MATLAB 両方に居る) は Linguist の
  language 名 ASCII 順で **first-write-wins** する。これと違う policy が必要な
  consumer は自前の override 層を被せる (例: `apps/renderer/src/features/preview/useHighlight.ts`)

Linguist の disambiguation 用 heuristics (content-based regex) は実装しない。
拡張子だけでは決まらない曖昧性は consumer 側 override で吸収する設計。

### Linguist alias と Shiki alias の突合は経験則

`resolveShikiId` の step 4 / 5 では「Linguist の alias 文字列が Shiki の alias と意味的に
同じ言語を指す」前提で突合する (例: Linguist `"proto"` ↔ Shiki `"proto"` alias)。両者は
独立に管理されているため厳密な保証は無いが、有名な言語については慣習的な短い alias
(`clj` / `js` / `objc` / `proto` 等) が両者で共通している経験則に依存する。新規 alias が
Linguist 側に追加された際に Shiki と意味が違う lang を指してしまうリスクは残るが、
影響が出れば consumer 側 override で吸収する想定。

### 診断出力

`bun scripts/generateExtensionLangMap.ts` 実行時に以下を stdout に出力する:

- **Ambiguous extensions**: 拡張子が複数 Shiki 言語に多重所属したケースの一覧
  (winner と losers)。consumer の override 判断材料として参照する
- **Unused NAME_TO_SHIKI entries**: 明示 alias table に書かれているが Linguist 名が
  存在しないか default rules で resolve できているエントリ。検出時は `process.exitCode = 1`
  で fail させ、不要な entry の蓄積を防ぐ

## 更新

`linguist-languages` を bump して `pnpm install` を再実行すれば `dist/` が再生成される。
