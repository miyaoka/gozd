# gozd

Git Orchestrated Zone for Development — AI エージェントの並列開発を管理するデスクトップアプリケーション。

## 開発時

```bash
pnpm run dev   # renderer（Vite HMR）と native（Swift app）を同時起動
```

## ビルド版

初回はビルドしてアプリを起動する。

```bash
pnpm run bootstrap
```

起動したアプリで `Shift+Cmd+P` でコマンドパレットを開き、`Shell Command: Install 'gozd' command in PATH` を実行すると `~/.local/bin/gozd` に CLI への symlink が作られる（`~/.local/bin` が PATH に通っている前提）。アンインストールは `Shell Command: Uninstall 'gozd' command from PATH`。

以降の再ビルドは `pnpm run build`。symlink は `.app` 内 wrapper を指すため、ビルドし直しても張り替え不要（`.app` を別の場所に移したときのみ install をやり直す）。

`gozd` CLI で任意のパスを開く。アプリが未起動であれば自動で起動する。

```bash
gozd              # カレントディレクトリで開く
gozd docs         # docs ディレクトリで開く
gozd src/main.ts  # src/ で開き、main.ts を開く
```
