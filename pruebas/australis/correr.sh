#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(corepack pnpm); fi
"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" exec playwright install chromium
"${PNPM[@]}" exec playwright test "$@"
