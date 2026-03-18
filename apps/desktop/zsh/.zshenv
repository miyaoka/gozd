# orkis zsh wrapper — ユーザーの .zshenv を source し、ZDOTDIR を orkis 側に戻す

_orkis_home="${ORKIS_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_orkis_home"
[[ -f "$_orkis_home/.zshenv" ]] && source "$_orkis_home/.zshenv"

# .zshenv が ZDOTDIR を変更した場合、その値を保存して orkis 側に戻す
export ORKIS_USER_ZDOTDIR="$ZDOTDIR"
export ZDOTDIR="$ORKIS_ZDOTDIR"
