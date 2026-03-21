# gozd zsh wrapper — ユーザーの .zprofile を透過的に読み込む

_gozd_user_zdotdir="${GOZD_USER_ZDOTDIR:-${GOZD_ORIG_ZDOTDIR:-$HOME}}"
export ZDOTDIR="$_gozd_user_zdotdir"
[[ -f "$_gozd_user_zdotdir/.zprofile" ]] && source "$_gozd_user_zdotdir/.zprofile"
export ZDOTDIR="$GOZD_ZDOTDIR"
