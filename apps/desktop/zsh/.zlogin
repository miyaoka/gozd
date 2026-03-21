# gozd zsh wrapper — ユーザーの .zlogin を透過的に読み込む
# .zlogin は zsh 初期化の最後に実行されるため、ここで ZDOTDIR をユーザー側に戻す

_gozd_user_zdotdir="${GOZD_USER_ZDOTDIR:-${GOZD_ORIG_ZDOTDIR:-$HOME}}"
export ZDOTDIR="$_gozd_user_zdotdir"
[[ -f "$_gozd_user_zdotdir/.zlogin" ]] && source "$_gozd_user_zdotdir/.zlogin"

# 初期化完了後は ZDOTDIR をユーザーの値に固定する（gozd 側に戻さない）
