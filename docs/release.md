# リリースと配布

GitHub Releases に tag と tar.gz を積み、mise の github backend でインストールする。

**署名・公証はしない**。mise 経由のダウンロードには quarantine 属性が付かず Gatekeeper にブロック
されない。Apple Silicon で必須の署名は、Electron の配布バイナリに焼かれた ad-hoc 署名がそのまま残る
ことで満たされる。**署名の identity を持たないため bundle の封印も生成されず、これは channel marker の
後書きが署名を壊さない前提でもある**。

改竄検知は署名の代わりに artifact attestation が担う。

## チャンネル

| チャンネル | トリガー                                    | tag 形式                     | Release    |
| ---------- | ------------------------------------------- | ---------------------------- | ---------- |
| canary     | main への push（feat / fix があるときだけ） | `v0.1.1-canary.<UTC 日時>`   | prerelease |
| stable     | 手動実行（事前に人間が version を bump）    | `v0.1.1`（バージョンと一致） | latest     |

判定・採番と、ビルド・添付を別の段階に分ける。**チャンネル別に直列実行を強制する** — canary の
日時採番で同刻衝突と時系列の逆転を防ぐため。

- **canary の発火判定**: 直近の tag から HEAD までに feat / fix があればリリースする。
  **依存更新の commit は scope の除外で落ちる。前提となる契約は「人間は依存更新用の scope を
  feat / fix で使わない」**（[コミット型の規律](../.claude/rules/commit.md)）
- **canary の採番**: 「最新 stable の次 patch + UTC 日時」。semver の順序が
  stable < canary < 次 stable で単調になり、**prerelease フラグだけでチャンネルを選べる**
  - **連番ではなく日時にする**のは、Release 一覧が同日グループ内をタグ名の**文字列比較**で並べるため。
    数値連番は同日 10 件を超えると並びが崩れ、API の返却順に依存する解決も誤る。
    **固定幅の日時なら文字列比較 = 時系列が常に成立する**
- **stable の検証**: tag の重複（bump し忘れ）と、最新 stable からの逆行はエラーで弾く

## バージョン管理

**バージョンの SSOT はリポジトリにコミットされた値**（GitHub Releases 配布の Electron アプリの
標準運用）。

- **stable**: 人間の bump commit が唯一の更新点。CI はリポジトリに書き戻さない
- **canary**: リポジトリに書き戻さない。**CI が採番した tag 由来のバージョンをビルドにだけ焼き込む**
  （実行中の canary を About パネルで判別できる）
- **ビルド識別子はバージョンとは別**で、全ビルドに commit の日時と hash が入る。About パネルの
  括弧内表示と、`~/Applications` 同期の比較キーを兼ねる
  - **未コミットの変更を含むビルドは hash に印が付き、表示と中身の不一致が自己申告される**
  - **識別子はパッケージ済みにしか存在しない**。開発中はビルド元でコードが見えるため焼き込まない

## 配布物

```text
gozd-macos-arm64.tar.gz
├── bin/
│   └── gozd -> ../Gozd.app/Contents/Resources/app/bin/gozd   # symlink
└── Gozd.app/
```

- asset 名は **mise が設定なしで OS / arch を自動検出できる命名**にする
- **ルートを 2 エントリにする**のは mise 対策。ルートがディレクトリ 1 個だけの tar は自動で 1 階層
  剥がされ、`.app` バンドルが解体される
- release notes は自動生成し、依存更新は除外する
- **ノートの範囲**: canary は直前リリースとの差分、stable は **前回の stable を起点にして canary
  サイクル全体を含める**。起点の自動決定はチャンネルを区別せず直前リリースに倒れるため、stable 側
  だけ明示が要る

## インストール

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

**1 ユーザーが追うのはどちらか片方**。同時併用はしない（アプリの identity はどちらも同じ stable
channel の「Gozd」になるため）。

## 更新の反映

パッケージマネージャの更新は実体を差し替えるだけで、**Dock ピンや Spotlight が指す固定パス
（`~/Applications/Gozd.app`）は動かない**。

固定パスへの同期は、どちらの経路も **ビルド識別子の比較 + atomic な差し替え**を通る冪等な操作で、
**stable channel だけが行う**。

- **主経路: インストール後フック**。新しいバージョンが入った直後に走り、**起動動線（Dock /
  Spotlight / ターミナル）に依存せず更新が伝播する**。更新の反映を起動時ではなく更新時に行う
  パッケージマネージャと同じモデル
- **バックアップ: 起動時の同期**。フック未設定の環境でもターミナル動線なら追従する
- **アプリ稼働中の同期も安全**。旧プロセスは開いた実体を掴んだまま動き続け、次回起動から新版になる
- **stable 以外の channel で同期を呼ぶとエラーで止める**（別 identity のアプリが固定パスを乗っ取る
  事故の防止）
- **固定パスには実体をコピーする。symlink にしない** — Spotlight は symlink を index しない

## channel identity

**リリースビルドだけが stable identity を名乗れる。** 判定の SSOT はビルド時に `.app` 内へ焼き込む
marker ファイル。

| channel | 生成経路                 | アプリ名   | bundle id 末尾 |
| ------- | ------------------------ | ---------- | -------------- |
| stable  | リリース CI              | Gozd       | （素）         |
| local   | 指定なしのローカルビルド | Gozd Local | `.local`       |
| dev     | 未パッケージ起動         | —          | —              |

- **marker が欠落・不正なパッケージ済みビルドは起動時エラーで止める**。静かに local へ倒すと、
  同じバンドル内の CLI と channel の認識がずれてアプリ起動中の open が壊れる
- 揮発リソース（socket / 起動要求 / hooks 設定）の分離は
  [architecture.md](architecture.md#channel-によるリソース分離)

役割分担:

| 段階                     | 使うもの     |
| ------------------------ | ------------ |
| 機能検証                 | 開発起動     |
| パッケージ検証・merge 前 | `Gozd Local` |
| merge 後                 | canary       |
