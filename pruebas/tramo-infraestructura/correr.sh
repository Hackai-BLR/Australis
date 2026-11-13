#!/usr/bin/env bash
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
HERR="$AQUI/.herramientas"
TOFU_VERSION="1.10.7"
TOFU_SHA256="c79bb458e7d7fa08c44be98b373ab3434647598808fc2a75dc9338aef7432ae6"

for anterior in "$REPO"/pruebas/fase-*/correr.sh; do
  [ -f "$anterior" ] || continue
  echo "== pruebas de $(basename "$(dirname "$anterior")")"
  bash "$anterior"
done

mkdir -p "$HERR/bin" "$HERR/colecciones" "$HERR/tofu-plugins"

if ! [ -x "$HERR/bin/tofu" ] || ! "$HERR/bin/tofu" version 2>/dev/null | grep -q "v$TOFU_VERSION"; then
  echo "== instalando OpenTofu $TOFU_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/tofu.zip" "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_amd64.zip"
  echo "$TOFU_SHA256  $tmp/tofu.zip" | sha256sum -c - >/dev/null
  unzip -o -q "$tmp/tofu.zip" tofu -d "$HERR/bin"
  chmod +x "$HERR/bin/tofu"
  rm -rf "$tmp"
fi

UV="$(command -v uv || true)"
[ -n "$UV" ] || UV="$HOME/.local/bin/uv"
if ! [ -x "$HERR/venv/bin/python" ]; then
  echo "== creando entorno de Python"
  "$UV" venv -q --python 3.12 "$HERR/venv"
fi
"$UV" pip install -q --python "$HERR/venv/bin/python" -r "$AQUI/requisitos.txt"

export PATH="$HERR/bin:$HERR/venv/bin:$PATH"
export ANSIBLE_COLLECTIONS_PATH="$HERR/colecciones"
export TF_PLUGIN_CACHE_DIR="$HERR/tofu-plugins"
export ANSIBLE_NOCOLOR=1
export ANSIBLE_FORCE_COLOR=0
export PYTHONDONTWRITEBYTECODE=1

echo "== instalando colecciones de Ansible"
ansible-galaxy collection install -r "$AQUI/colecciones.yml" -p "$HERR/colecciones" >/dev/null
if [ -f "$REPO/infraestructura/servidor/requirements.yml" ]; then
  ansible-galaxy collection install -r "$REPO/infraestructura/servidor/requirements.yml" -p "$HERR/colecciones" >/dev/null || echo "no se pudieron instalar las colecciones de infraestructura/servidor/requirements.yml"
fi

cd "$AQUI"
exec python -m pytest "$@"
