# gozd zsh wrapper — ユーザーの .zshenv を source し、ZDOTDIR を gozd 側に戻す

_gozd_home="${GOZD_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_gozd_home"
[[ -f "$_gozd_home/.zshenv" ]] && source "$_gozd_home/.zshenv"

# .zshenv が ZDOTDIR を変更した場合、その値を保存して gozd 側に戻す
export GOZD_USER_ZDOTDIR="$ZDOTDIR"
export ZDOTDIR="$GOZD_ZDOTDIR"
