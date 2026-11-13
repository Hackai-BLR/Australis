#!/usr/bin/env bash
set -euo pipefail

uso() {
	echo "uso: construir-espacio.sh [--etiqueta <imagen>] [--cli docker|podman] [--plantilla <carpeta>] [--espacio <carpeta>]" >&2
	exit 2
}

falla() {
	echo "construir-espacio.sh: $*" >&2
	exit 1
}

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETIQUETA="campusia-espacio:1"
CLI="docker"
PLANTILLA=""
ESPACIO=""

while [ $# -gt 0 ]; do
	case "$1" in
		--etiqueta) [ $# -ge 2 ] || uso; ETIQUETA="$2"; shift 2 ;;
		--cli) [ $# -ge 2 ] || uso; CLI="$2"; shift 2 ;;
		--plantilla) [ $# -ge 2 ] || uso; PLANTILLA="$2"; shift 2 ;;
		--espacio) [ $# -ge 2 ] || uso; ESPACIO="$2"; shift 2 ;;
		-h|--help) uso ;;
		*) echo "opción desconocida: $1" >&2; uso ;;
	esac
done

case "$CLI" in
	docker|podman) ;;
	*) falla "--cli tiene que ser docker o podman" ;;
esac
command -v "$CLI" >/dev/null || falla "no se encontró $CLI"
[ -n "$ETIQUETA" ] || falla "falta la etiqueta"

if [ -z "$ESPACIO" ]; then
	for candidato in "$AQUI/espacio-trabajo" /srv/campusia/plataforma/espacio-trabajo; do
		if [ -f "$candidato/Containerfile" ]; then
			ESPACIO="$candidato"
			break
		fi
	done
fi
[ -n "$ESPACIO" ] && [ -f "$ESPACIO/Containerfile" ] || falla "no se encontró la carpeta del espacio de trabajo con su Containerfile"

if [ -z "$PLANTILLA" ]; then
	for candidato in "$AQUI/../plantilla-curso" /srv/campusia/plataforma/plantilla-curso; do
		if [ -f "$candidato/package.json" ] && [ -f "$candidato/pnpm-lock.yaml" ]; then
			PLANTILLA="$candidato"
			break
		fi
	done
fi
[ -n "$PLANTILLA" ] && [ -f "$PLANTILLA/package.json" ] && [ -f "$PLANTILLA/pnpm-lock.yaml" ] || falla "no se encontró la plantilla de cursos con package.json y pnpm-lock.yaml"

CONTEXTO="$(mktemp -d "${TMPDIR:-/tmp}/campusia-espacio.XXXXXX")"
trap 'rm -rf "$CONTEXTO"' EXIT

tar -C "$ESPACIO" -cf - . | tar -C "$CONTEXTO" -xf -
mkdir -p "$CONTEXTO/plantilla"
cp "$PLANTILLA/package.json" "$PLANTILLA/pnpm-lock.yaml" "$CONTEXTO/plantilla/"
if compgen -G "$PLANTILLA/vendor/campusia-sdk-*.tgz" >/dev/null; then
	mkdir -p "$CONTEXTO/plantilla/vendor"
	cp "$PLANTILLA"/vendor/campusia-sdk-*.tgz "$CONTEXTO/plantilla/vendor/"
fi
if grep -RIlE 'sk-ant-[a-z]{3}[0-9]{2}-' "$CONTEXTO" >/dev/null 2>&1; then
	falla "el contexto de la imagen contiene algo parecido a una credencial de Anthropic"
fi

echo "construyendo $ETIQUETA con $CLI"
"$CLI" build --pull=false -t "$ETIQUETA" -f "$CONTEXTO/Containerfile" "$CONTEXTO"
"$CLI" image inspect "$ETIQUETA" >/dev/null
echo "imagen $ETIQUETA lista"
