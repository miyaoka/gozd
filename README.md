# gozd

Git Orchestrated Zone for Development — AI エージェントの並列開発を管理するデスクトップアプリケーション。

## 開発時

```bash
pnpm dev   # renderer（Vite HMR）と native（Swift app）を同時起動
```

## ビルド版

初回のみ CLI にパスを通す。

```bash
ln -s "$(pwd)/apps/native/.build/app/Gozd.app/Contents/Resources/app/bin/gozd" ~/.local/bin/gozd
```

ビルドして起動する。

```bash
pnpm build
pnpm dev:prod
```

`gozd` CLI で任意のパスを開く。アプリが未起動であれば自動で起動する。

```bash
gozd              # カレントディレクトリで開く
gozd docs         # docs ディレクトリで開く
gozd src/main.ts  # src/ で開き、main.ts を開く
```
