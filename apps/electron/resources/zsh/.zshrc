# gozd zsh wrapper — ユーザーの .zshrc を source した後に claude() を注入する

# .zshenv が検出したユーザーの本当の ZDOTDIR を使う
_gozd_user_zdotdir="${GOZD_USER_ZDOTDIR:-${GOZD_ORIG_ZDOTDIR:-$HOME}}"
export ZDOTDIR="$_gozd_user_zdotdir"
[[ -f "$_gozd_user_zdotdir/.zshrc" ]] && source "$_gozd_user_zdotdir/.zshrc"

# .zshrc は non-login shell の最後の初期化ファイルなので、ZDOTDIR をユーザー側に固定する
# （gozd 側に戻さない。claude() 関数は環境変数で動作するため ZDOTDIR に依存しない）

# CWD を OSC 7 でターミナルに通知する（xterm.js 側で registerOscHandler(7) で受け取る）。
# 受信側（parseOsc7Cwd）は decodeURIComponent を通すため `%` だけ `%25` に escape する。
# 非 ASCII は生 UTF-8 のまま送っても decode で素通りするので full encode は不要で、
# パス中の literal `%XX` が誤 decode されるのだけを防げばよい
_gozd_osc7_cwd() {
  printf '\e]7;file://%s%s\a' "${HOST}" "${PWD//\%/%25}"
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
  # dead sid を `tasks.json` から掃除する)。
  claude --resume "$_id"
  local _exit=$?
  # fallback の発火範囲は exit code の denylist で決める。
  # 除外: 0 (正常終了 /exit) / 130 (SIGINT = Ctrl-C 抜け) / 143 (SIGTERM)。これらは
  # ユーザー操作で claude を終わらせたケースなので、fallback すると resume 成功した
  # セッションを抜けた直後に勝手に新 session が立ち上がる (transcript が Claude 側の
  # ファイルに残っているのに gozd 側からは旧 sid が dead 扱いされる + 副次的に
  # 2 度目 SessionStart の previous != hook.sessionID 経路で旧 sid の task が
  # detach される) という UX 破壊を生む。
  # 発火: それ以外の全ての非 0。transcript 不在 (resume 起動失敗) の他、claude 自身
  # の runtime error (auth / network / API rate limit 等で会話中に非 0 終了したケース)
  # も含む。後者では新規 session が立ち上がるが、「resume できる前提が壊れたら新
  # session で再開する」仕様として認める。allowlist (transcript 不在のみを判定) は
  # 実装不能 (claude が固有 exit code を分離出力していないため) なので denylist で
  # 表現する。
  case $_exit in
    0|130|143) ;;
    *) claude ;;
  esac
}
[[ -n "$GOZD_RESUME_CLAUDE_SESSION" ]] && _gozd_resume_claude

# session 未紐付け task をサイドバーでクリックした場合、resume せず素の claude を起動する。
# SessionStart hook が走った後、native 側 attachSession が「sessionId 空の最新 task」に
# 新 sessionId を結びつけることで task と session の紐付けが成立する。
#
# GOZD_CLAUDE_PREFILL があれば `claude --prefill <text>` で入力欄にテキストを事前挿入する
# (挿入のみで送信はされない)。renderer が spawn env に注入する。--prefill は claude CLI の
# hidden option (--help に出ない)。採用理由は docs/task.md「PR/issue URL の prefill」を参照。
_gozd_start_claude() {
  unset GOZD_AUTOSTART_CLAUDE
  local _prefill="$GOZD_CLAUDE_PREFILL"
  unset GOZD_CLAUDE_PREFILL
  if [[ -n "$_prefill" ]]; then
    claude --prefill "$_prefill"
  else
    claude
  fi
}
[[ -n "$GOZD_AUTOSTART_CLAUDE" ]] && _gozd_start_claude

# worktree 作成時の setup スクリプト（project 設定 setupScript、例: `pnpm install`）を
# 専用ターミナル leaf で実行する。renderer が spawn env に GOZD_SETUP_SCRIPT を注入する。
#
# eval を使う理由: setupScript は複数行を許すため（例: `node setup.mjs` 改行 `pnpm install`）。
# exec しない理由: 実行後は素のシェルプロンプトに戻り、ユーザーが出力を確認・追加操作できる。
_gozd_run_setup() {
  local _script="$GOZD_SETUP_SCRIPT"
  unset GOZD_SETUP_SCRIPT
  # このターミナルが setup script 実行用であることを明示する。ヘッダに続けて実行する
  # コマンド本体を出す（print -r で % を prompt escape 解釈させずリテラル表示）。
  print -P "%F{6}%B❯ gozd setup script%b%f"
  print -r -- "$_script"
  print
  eval "$_script"
}
[[ -n "$GOZD_SETUP_SCRIPT" ]] && _gozd_run_setup
