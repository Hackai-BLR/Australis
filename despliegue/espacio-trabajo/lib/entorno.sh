if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then
	HOME=/tmp/campusia-home
fi
mkdir -p "$HOME" 2>/dev/null
chmod 700 "$HOME" 2>/dev/null
export HOME
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
export pnpm_config_store_dir="${pnpm_config_store_dir:-/tmp/campusia-pnpm-store}"
export pnpm_config_update_notifier=false
export npm_config_update_notifier=false
