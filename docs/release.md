# リリースと配布

GitHub Releases（miyaoka/gozd）に tag + tar.gz を積み、mise の github backend でインストールする。
署名・公証はしない（mise 経由のダウンロードには quarantine 属性が付かず Gatekeeper に
ブロックされない。Apple Silicon で必須の Mach-O 署名は、Electron 配布バイナリに焼かれた
linker-signed ad-hoc 署名がそのまま残ることで満たされる。identity が無いため
electron-builder の署名ステップはスキップされ bundle seal は生成されない — seal を
作らないことは、channel marker の後書きが署名を壊さない前提でもある）。
改竄検知は署名の代わりに artifact attestation（`actions/attest-build-provenance`）が担う。

## チャンネル

| チャンネル | トリガー                                               | tag 形式                      | GitHub Release |
| ---------- | ------------------------------------------------------ | ----------------------------- | -------------- |
| canary     | main への push（feat / fix があるときだけ）            | `v0.1.1-canary.3`（自動採番） | prerelease     |
| stable     | workflow_dispatch（事前に人間が package.json を bump） | `v0.1.1`（package.json 一致） | latest         |

実装は `.github/workflows/release.yml`。decide job（判定・採番）と release job（macOS arm64 で
build → tar → attest → release）の 2 段で、`concurrency: release` により常に直列実行する。

- **canary の発火判定**: 直近の tag（チャンネル問わず）から HEAD の commit subject に
  feat / fix（`!` 付き breaking 含む）があればリリース。renovate の commit は全件 scope
  `(deps)` を持つため `(deps)` scope の除外で落ちる。前提の契約: 人間は scope `deps` を
  feat / fix で使わない
- **canary の採番**: 「最新 stable の次 patch + 連番」。連番は既存 canary tag の max + 1、
  stable が進んだら `canary.0` から再カウント。semver 順序が stable < canary < 次 stable で
  単調になり、mise は prerelease フラグだけでチャンネルを選べる
- **stable の検証**: tag 重複（bump し忘れ）と最新 stable からの逆行はエラーで弾く

## バージョン管理

`apps/electron/package.json` の version が SSOT で、実バージョンをコミットして管理する
（GitHub Releases 配布の Electron アプリの標準運用。element-desktop / Signal-Desktop /
rancher-desktop 等と同型）。

- stable: 人間の bump commit が version の唯一の更新点。CI は repo に書き戻さない
- canary: repo に書き戻さない。CI が tag 台帳から採番した version を electron-builder の
  `extraMetadata.version` でビルドにのみ焼き込む（About パネルで実行中の canary を判別できる）
- `CFBundleVersion` は version とは別で、全ビルドに commit 日時 + hash が入る
  （About パネル括弧内の識別と wrapper 同期の比較キー。buildApp.ts）

## 配布物

```text
gozd-macos-arm64.tar.gz
├── bin/
│   └── gozd -> ../Gozd.app/Contents/Resources/app/bin/gozd   # symlink
└── Gozd.app/
```

- asset 名は mise が `asset_pattern` 設定なしで OS / arch を自動検出できる命名
- ルートを `bin/` + `Gozd.app/` の 2 エントリにするのは mise 対策。ルートがディレクトリ
  1 個だけの tar は `strip_components=1` が自動適用され `.app` バンドルが解体される
- release notes は `--generate-notes` 自動生成。renovate / dependencies は
  `.github/release.yml` で除外する

## mise インストール

```toml
# canary を追う
[tools."github:miyaoka/gozd"]
version = "latest"
prerelease = true
postinstall = '"$MISE_TOOL_INSTALL_PATH/bin/gozd" sync-app'

# stable のみ
[tools."github:miyaoka/gozd"]
version = "latest"
postinstall = '"$MISE_TOOL_INSTALL_PATH/bin/gozd" sync-app'
```

- `postinstall` は README の `mise use` ワンライナー（bracket 構文）で設定される。
  tool-level postinstall は「そのツールの新バージョンがインストールされた直後」に走り、
  `MISE_TOOL_INSTALL_PATH` がインストール先を指す（mise の契約）

1 ユーザーが追うのはどちらか片方の前提で、同時併用はしない（アプリ identity はどちらも
同じ stable channel の「Gozd」）。

## 更新の反映（~/Applications への同期）

`mise up` は mise 側の実体を差し替えるだけで、Dock ピン / Spotlight が指す固定パスは動かない。
固定パスへの同期はどちらの経路も wrapper `bin/gozd` の `sync_installed_app`
（`CFBundleVersion` 比較 + APFS clone `cp -Rc` + mv の atomic 差し替え）を通る冪等な操作で、
stable channel だけが行う。

- **主経路: mise の postinstall**。`mise up` で新バージョンが入った直後に
  `"$MISE_TOOL_INSTALL_PATH/bin/gozd" sync-app` が走り、起動動線（Dock / Spotlight /
  ターミナル）に依存せず更新が伝播する。更新の反映を起動時ではなく更新時に行う
  Homebrew cask と同じモデル
- **バックアップ: cold start 同期**。wrapper がターミナル起動の cold start 時に同期する。
  postinstall 未設定の環境でもターミナル動線なら追従する
- アプリ稼働中の同期も安全。旧プロセスは開いた inode を掴んだまま動き続け、次回起動から
  新版になる（cask の upgrade と同じセマンティクス）
- `sync-app` を stable 以外の channel で呼ぶとエラーで止める（`Gozd Local.app` が
  `~/Applications/Gozd.app` を乗っ取る事故の防止）
- Spotlight は `~/Applications` 配下の実体 copy を index する（symlink は index されない。
  Homebrew cask が symlink 方式を廃止した既知の理由）

## channel identity

リリースビルドだけが stable identity を名乗れる。判定の SSOT はビルド時に `.app` 内へ
焼き込む marker ファイル `Contents/Resources/app/channel`（buildApp.ts が書き、main の
gozdEnv と wrapper `bin/gozd` が読む）。

| channel | 生成経路                                  | productName | bundle id 末尾 | socket                 |
| ------- | ----------------------------------------- | ----------- | -------------- | ---------------------- |
| stable  | release CI（`GOZD_BUILD_CHANNEL=stable`） | Gozd        | （素）         | `gozd-stable.sock`     |
| local   | 無指定の `build:app`                      | Gozd Local  | `.local`       | `gozd-local.sock`      |
| dev     | `pnpm dev`（未パッケージ）                | —           | —              | `gozd-dev-<hash>.sock` |

- packaged なのに marker が欠落・不正なビルドは起動時エラーで止める（marker 導入前の
  古いビルドはビルドし直す。静かに local へ倒すと同バンドル内 wrapper と channel 認識が
  ずれ warm start が壊れるため）
- 役割分担: 機能検証は `pnpm dev`（HMR）、packaged 検証と merge 前の dogfooding は
  `Gozd Local`、merge 後は canary を mise で入れて配布経路ごと dogfooding する
