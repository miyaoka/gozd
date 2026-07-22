# コミット型の規律

release workflow は main 上の feat / fix commit を検知して canary リリースを自動発行する
（`.github/workflows/release.yml` の発火判定）。コミット型は変更した領域ではなく
**配布物（`.app` の中身）に影響するか**で選ぶ。

- feat / fix: 配布物に現れる変更のみ。リリース配管・CI・docs だけの変更に付けると、
  中身の変わらない canary が発火する
- リリース配管・workflow・CI の変更は ci を使う。release.yml 自体の修正も
  「release 機能の fix」ではなく ci
- scope `deps` を feat / fix で使わない（renovate 除外の前提契約。docs/release.md）

迷ったら「この commit だけで canary が出たとき、`.app` のバイトが変わるか」で判定する。
