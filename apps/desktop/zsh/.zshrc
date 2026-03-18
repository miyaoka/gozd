# orkis zsh wrapper — ユーザーの .zshrc を source した後に claude() を注入する

# .zshenv が検出したユーザーの本当の ZDOTDIR を使う
_orkis_user_zdotdir="${ORKIS_USER_ZDOTDIR:-${ORKIS_ORIG_ZDOTDIR:-$HOME}}"
export ZDOTDIR="$_orkis_user_zdotdir"
[[ -f "$_orkis_user_zdotdir/.zshrc" ]] && source "$_orkis_user_zdotdir/.zshrc"

# .zshrc は non-login shell の最後の初期化ファイルなので、ZDOTDIR をユーザー側に固定する
# （orkis 側に戻さない。claude() 関数は環境変数で動作するため ZDOTDIR に依存しない）

# claude コマンドをラップして --settings を自動注入
claude() {
  local arg
  for arg in "$@"; do
    [[ "$arg" == --settings || "$arg" == --settings=* ]] && {
      command claude "$@"
      return $?
    }
  done
  command claude --settings "$ORKIS_CLAUDE_SETTINGS_PATH" "$@"
}
