#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm exec playwright test "$@"
