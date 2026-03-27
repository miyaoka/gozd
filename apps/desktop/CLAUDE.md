## エラーハンドリング

- 例外処理では必ず `notify()` でクライアント（renderer）に通知する。`console.error` だけで握りつぶさない
- `notify("error", source, message, cause?)` でエラー、`notify("info", source, message)` で情報を送る
