# gozd zsh wrapper — ユーザーの .zshrc を source した後に claude() を注入する

# .zshenv が検出したユーザーの本当の ZDOTDIR を使う
_gozd_user_zdotdir="${GOZD_USER_ZDOTDIR:-${GOZD_ORIG_ZDOTDIR:-$HOME}}"
export ZDOTDIR="$_gozd_user_zdotdir"
[[ -f "$_gozd_user_zdotdir/.zshrc" ]] && source "$_gozd_user_zdotdir/.zshrc"

# .zshrc は non-login shell の最後の初期化ファイルなので、ZDOTDIR をユーザー側に固定する
# （gozd 側に戻さない。claude() 関数は環境変数で動作するため ZDOTDIR に依存しない）

# CWD を OSC 7 でターミナルに通知する（xterm.js 側で registerOscHandler(7) で受け取る）
_gozd_osc7_cwd() {
  printf '\e]7;file://%s%s\a' "${HOST}" "${PWD}"
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _gozd_osc7_cwd
_gozd_osc7_cwd

# claude コマンドをラップして --settings を自動注入
claude() {
  local arg
  for arg in "$@"; do
    [[ "$arg" == --settings || "$arg" == --settings=* ]] && {
      command claude "$@"
      return $?
    }
  done
  command claude --settings "$GOZD_CLAUDE_SETTINGS_PATH" "$@"
}

# アプリ再起動を跨いで Claude セッションを復元する。
# native 側が PTY spawn 時に GOZD_RESUME_CLAUDE_SESSION=<sessionId> を env に注入する。
# ユーザーが Claude を抜けると素のシェルプロンプトに戻るよう exec はしない。
#
# function 化する理由:
# - local で sessionId を保持し関数終了時に自動破棄するため
# - 関数の最後の文を `claude --resume` にすることで、$? が claude の終了コードに
#   なる（unset を後置すると $? が unset の戻り値で上書きされる）
_gozd_resume_claude() {
  local _id="$GOZD_RESUME_CLAUDE_SESSION"
  unset GOZD_RESUME_CLAUDE_SESSION
  # `claude --resume <sid>` は transcript 不在 (= 一度も会話が確定していない session
  # に対する resume) で「No conversation found ...」を出して非 0 で抜ける。pane を
  # 閉じてもらわなくても済むよう素の `claude` を続けて起動し、新 SessionStart 経由で
  # task を再 attach する (native 側 RpcDispatcher.applyClaudeSessionHook が
  # 「expected と異なる sid の SessionStart」を resume 失敗 + fallback と判定し
  # dead sid を `claude-sessions.json` / `tasks.json` から掃除する)。
  claude --resume "$_id"
  local _exit=$?
  # fallback の発火範囲は「resume が起動できなかった起動失敗系」に限定する。
  # ユーザー操作で claude を終わらせた exit code (0=正常終了 /exit, 130=SIGINT で
  # Ctrl-C 抜け, 143=SIGTERM) で fallback すると、resume 成功したセッションを抜けた
  # ユーザーに勝手に新 session を立ち上げてしまう。これは transcript が Claude 側
  # のファイルに残っているのに gozd 側からは旧 sid が dead 扱いされる挙動 (副次的に
  # 2 度目 SessionStart の previous != hook.sessionID 経路で旧 sid が
  # claude-sessions.json から削除される) を生む。
  case $_exit in
    0|130|143) ;;
    *) claude ;;
  esac
}
[[ -n "$GOZD_RESUME_CLAUDE_SESSION" ]] && _gozd_resume_claude

# session 未紐付け task をサイドバーでクリックした場合、resume せず素の claude を起動する。
# SessionStart hook が走った後、native 側 attachSession が「sessionId 空の最新 task」に
# 新 sessionId を結びつけることで task と session の紐付けが成立する。
_gozd_start_claude() {
  unset GOZD_AUTOSTART_CLAUDE
  claude
}
[[ -n "$GOZD_AUTOSTART_CLAUDE" ]] && _gozd_start_claude
