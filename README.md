# orkis

AI Agent Orchestrator — AI エージェントの並列開発を管理するデスクトップアプリケーション。

## 開発時

```bash
pnpm dev   # renderer（Vite HMR）と desktop を同時起動
```

## ビルド版

初回のみ CLI にパスを通す。

```bash
ln -s "$(pwd)/apps/desktop/build/stable-macos-arm64/orkis.app/Contents/Resources/app/bin/orkis" ~/.local/bin/orkis
```

ビルドして起動する。初回は `open` で `.app` を一度起動し、CLI バイナリを展開する必要がある。

```bash
pnpm build
pnpm open
```

`orkis` CLI で任意のパスを開く。アプリが未起動であれば自動で起動する。

```bash
orkis              # カレントディレクトリで開く
orkis docs         # docs ディレクトリで開く
orkis src/main.ts  # src/ で開き、main.ts を開く
```
