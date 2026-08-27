# gozd の Claude Code plugin

gozd がターミナルで起動する claude に `--plugin-dir` で渡すディレクトリ。zsh init が
`GOZD_CLAUDE_PLUGIN_DIR` を読んで注入する（hooks 設定を `--settings` で渡すのと同じ経路）。

このディレクトリの skill は **gozd のターミナルの中でだけ見える**。skill が使う `gozd` CLI は
稼働中のウィンドウへソケットで要求を届けるため、gozd の外では実行手段が無い。ユーザーの
`~/.claude/` には何も置かない。

Claude Code が plugin を読むのに要求する構造は `.claude-plugin/plugin.json` と
`skills/<name>/SKILL.md`。skill は `<plugin 名>:<skill 名>` で参照される（`gozd:worktree`）。
`claude plugin validate <dir>` で構造を検証できる。
