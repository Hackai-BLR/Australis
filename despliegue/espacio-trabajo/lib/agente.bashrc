if [ -n "${CAMPUSIA_TOKEN_AGENTE:-}" ]; then
	export -n CAMPUSIA_TOKEN_AGENTE
fi
node() {
	if [ -n "${CAMPUSIA_TOKEN_AGENTE:-}" ]; then
		CAMPUSIA_TOKEN_AGENTE="$CAMPUSIA_TOKEN_AGENTE" command node --import /usr/local/lib/campusia/sdk-fijo.mjs "$@"
	else
		command node --import /usr/local/lib/campusia/sdk-fijo.mjs "$@"
	fi
}
