#!/usr/bin/env bash
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$AQUI"
export PYTHONDONTWRITEBYTECODE=1
exec python3 -m pytest "$@"
