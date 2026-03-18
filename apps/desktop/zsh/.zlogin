# orkis zsh wrapper — ユーザーの .zlogin を透過的に読み込む
# .zlogin は zsh 初期化の最後に実行されるため、ここで ZDOTDIR をユーザー側に戻す

_orkis_user_zdotdir="${ORKIS_USER_ZDOTDIR:-${ORKIS_ORIG_ZDOTDIR:-$HOME}}"
export ZDOTDIR="$_orkis_user_zdotdir"
[[ -f "$_orkis_user_zdotdir/.zlogin" ]] && source "$_orkis_user_zdotdir/.zlogin"

# 初期化完了後は ZDOTDIR をユーザーの値に固定する（orkis 側に戻さない）
