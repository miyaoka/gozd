# orkis

AI Agent Orchestrator — AI エージェントの Plan-Implement-Review ループを管理するデスクトップアプリケーション。

## 起動方法

### CLI から起動（推奨）

`bin/orkis` は VS Code の `code` コマンドに相当するエントリーポイント。

```bash
bin/orkis              # カレントディレクトリで開く
bin/orkis docs         # docs ディレクトリで開く
bin/orkis src/main.ts  # src/ で開き、main.ts を開く
```

アプリが未起動であれば自動で Electron を起動する（`dist/` がなければビルドも自動実行）。既に起動済みであればソケット経由で既存プロセスにメッセージを送る。

### 開発時

```bash
# dev サーバーで起動（HMR 有効）
pnpm dev

# 別ターミナルで CLI の動作確認
bin/orkis docs
```

`bin/orkis` はソケットの有無でアプリの起動状態を判定する。`pnpm dev` が起動していれば、`bin/orkis` は新たにアプリを起動せず dev プロセスに接続するため、HMR が効いた状態でデバッグできる。

### その他

```bash
pnpm build && pnpm start   # ビルド済みアプリを直接起動（CLI 経由の起動フローを通らない）
```
