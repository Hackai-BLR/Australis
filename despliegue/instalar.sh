#!/usr/bin/env bash
set -euo pipefail

uso() {
	echo "uso: instalar.sh --binario <ruta> --interfaz <carpeta> [--plantilla <carpeta>] [--sdk <carpeta>] [--espacio <carpeta>] [--australis-binario <ruta> --australis-frontend <carpeta>] [--raiz <carpeta>] [--sin-servicios]" >&2
	exit 2
}

falla() {
	echo "instalar.sh: $*" >&2
	exit 1
}

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARIO=""
INTERFAZ=""
RAIZ=""
PLANTILLA=""
SDK=""
ESPACIO=""
AUSTRALIS_BINARIO=""
AUSTRALIS_FRONTEND=""
SERVICIOS=1

while [ $# -gt 0 ]; do
	case "$1" in
		--binario) [ $# -ge 2 ] || uso; BINARIO="$2"; shift 2 ;;
		--interfaz) [ $# -ge 2 ] || uso; INTERFAZ="$2"; shift 2 ;;
		--raiz) [ $# -ge 2 ] || uso; RAIZ="$2"; shift 2 ;;
		--plantilla) [ $# -ge 2 ] || uso; PLANTILLA="$2"; shift 2 ;;
		--sdk) [ $# -ge 2 ] || uso; SDK="$2"; shift 2 ;;
		--espacio) [ $# -ge 2 ] || uso; ESPACIO="$2"; shift 2 ;;
		--australis-binario) [ $# -ge 2 ] || uso; AUSTRALIS_BINARIO="$2"; shift 2 ;;
		--australis-frontend) [ $# -ge 2 ] || uso; AUSTRALIS_FRONTEND="$2"; shift 2 ;;
		--sin-servicios) SERVICIOS=0; shift ;;
		-h|--help) uso ;;
		*) echo "opción desconocida: $1" >&2; uso ;;
	esac
done

[ -n "$BINARIO" ] || falla "falta --binario"
[ -n "$INTERFAZ" ] || falla "falta --interfaz"
[ -f "$BINARIO" ] || falla "no existe el binario: $BINARIO"
[ -d "$INTERFAZ" ] || falla "no existe la interfaz: $INTERFAZ"
[ -f "$INTERFAZ/index.html" ] || falla "la interfaz no tiene index.html: $INTERFAZ"
if [ -n "$PLANTILLA" ]; then
	[ -d "$PLANTILLA" ] || falla "no existe la plantilla: $PLANTILLA"
	PLANTILLA="$(cd "$PLANTILLA" && pwd)"
	compgen -G "$PLANTILLA/vendor/campusia-sdk-*.tgz" >/dev/null || falla "la plantilla no tiene vendor/campusia-sdk-*.tgz: $PLANTILLA"
fi
if [ -n "$SDK" ]; then
	[ -d "$SDK" ] || falla "no existe el SDK: $SDK"
	[ -f "$SDK/package.json" ] || falla "el SDK no tiene package.json: $SDK"
	SDK="$(cd "$SDK" && pwd)"
fi
if [ -n "$ESPACIO" ]; then
	[ -d "$ESPACIO" ] || falla "no existe el espacio de trabajo: $ESPACIO"
	[ -f "$ESPACIO/Containerfile" ] || falla "el espacio de trabajo no tiene Containerfile: $ESPACIO"
	ESPACIO="$(cd "$ESPACIO" && pwd)"
fi
if [ -n "$AUSTRALIS_BINARIO" ] || [ -n "$AUSTRALIS_FRONTEND" ]; then
	[ -n "$AUSTRALIS_BINARIO" ] && [ -n "$AUSTRALIS_FRONTEND" ] || falla "--australis-binario y --australis-frontend van juntos"
	[ -f "$AUSTRALIS_BINARIO" ] || falla "no existe el binario de Australis: $AUSTRALIS_BINARIO"
	[ -d "$AUSTRALIS_FRONTEND" ] || falla "no existe el frontend de Australis: $AUSTRALIS_FRONTEND"
	[ -f "$AUSTRALIS_FRONTEND/index.html" ] || falla "el frontend de Australis no tiene index.html: $AUSTRALIS_FRONTEND"
	AUSTRALIS_FRONTEND="$(cd "$AUSTRALIS_FRONTEND" && pwd)"
fi
for f in campusia-nucleo.service campusia-australis.service australis.env.ejemplo Caddyfile respaldo/respaldar.sh respaldo/restaurar.sh respaldo/campusia-respaldo.service respaldo/campusia-respaldo.timer; do
	[ -f "$AQUI/$f" ] || falla "falta $AQUI/$f"
done

if [ -n "$RAIZ" ]; then
	mkdir -p "$RAIZ"
	RAIZ="$(cd "$RAIZ" && pwd)"
	[ "$RAIZ" = "/" ] && RAIZ=""
fi

if [ "$SERVICIOS" = 1 ] && [ "$(id -u)" != 0 ]; then
	falla "sin --sin-servicios hay que correrlo como root"
fi

BIN_DESTINO="$RAIZ/usr/local/bin/campusia-nucleo"
SRV="$RAIZ/srv/campusia"
INTERFAZ_DESTINO="$SRV/interfaz"
DATOS="$SRV/datos"
CONFIG="$SRV/config"
CURSOS="$SRV/cursos"
ARCHIVOS="$SRV/archivos"
RESPALDOS="$SRV/respaldos"
PLATAFORMA="$SRV/plataforma"
PLANTILLA_DESTINO="$PLATAFORMA/plantilla-curso"
SDK_DESTINO="$PLATAFORMA/sdk"
ESPACIO_DESTINO="$PLATAFORMA/espacio-trabajo"
ESPACIOS="$SRV/espacios"
ENTORNO_ARCHIVO="$CONFIG/campusia.env"
UNIDADES_DIR="$RAIZ/etc/systemd/system"
UNIDAD_DESTINO="$UNIDADES_DIR/campusia-nucleo.service"
DESPLIEGUE_DESTINO="$PLATAFORMA/despliegue"
RESPALDO_DESTINO="$DESPLIEGUE_DESTINO/respaldo"
CADDY_DESTINO="$RAIZ/etc/caddy/Caddyfile"
BASE="$DATOS/campusia.db"
AUSTRALIS="$SRV/australis"
AUSTRALIS_DATOS="$AUSTRALIS/datos"
AUSTRALIS_ARCHIVOS="$AUSTRALIS/archivos"
AUSTRALIS_FRONTEND_DESTINO="$AUSTRALIS/frontend"
AUSTRALIS_BIN_DESTINO="$RAIZ/usr/local/bin/australis-server"
AUSTRALIS_ENTORNO="$CONFIG/australis.env"
AUSTRALIS_UNIDAD="$UNIDADES_DIR/campusia-australis.service"
AUSTRALIS_PUERTO=8090

if [ "$SERVICIOS" = 1 ]; then
	if ! getent group campusia >/dev/null; then
		groupadd --system campusia
	fi
	if ! id -u campusia >/dev/null 2>&1; then
		useradd --system --gid campusia --home-dir /srv/campusia --no-create-home --shell /usr/sbin/nologin campusia
	fi
	if [ -f /etc/subuid ] && ! grep -q '^campusia:' /etc/subuid; then
		INICIO="$(awk -F: 'BEGIN{m=100000} {f=$2+$3; if (f>m) m=f} END{print m}' /etc/subuid /etc/subgid)"
		usermod --add-subuids "$INICIO-$((INICIO + 65535))" --add-subgids "$INICIO-$((INICIO + 65535))" campusia
	fi
	if command -v loginctl >/dev/null; then
		loginctl enable-linger campusia || true
	fi
	[ -f "$ENTORNO_ARCHIVO" ] || falla "falta $ENTORNO_ARCHIVO; copiá $AQUI/campusia.env.ejemplo y completalo"
	if [ -n "$AUSTRALIS_BINARIO" ]; then
		[ -f "$AUSTRALIS_ENTORNO" ] || falla "falta $AUSTRALIS_ENTORNO; copiá $AQUI/australis.env.ejemplo y completalo"
	fi
fi

mkdir -p "$RAIZ/usr/local/bin" "$SRV" "$DATOS" "$CONFIG" "$CURSOS" "$ARCHIVOS" "$RESPALDOS" "$ESPACIOS" "$PLATAFORMA" "$(dirname "$UNIDAD_DESTINO")" "$(dirname "$CADDY_DESTINO")"

TMP_BIN="$(mktemp "$RAIZ/usr/local/bin/.campusia-nucleo.XXXXXX")"
cp "$BINARIO" "$TMP_BIN"
chmod 0755 "$TMP_BIN"
mv -f "$TMP_BIN" "$BIN_DESTINO"

TMP_INTERFAZ="$(mktemp -d "$SRV/.interfaz.XXXXXX")"
cp -R "$INTERFAZ/." "$TMP_INTERFAZ/"
chmod 0755 "$TMP_INTERFAZ"
if [ -e "$INTERFAZ_DESTINO" ]; then
	VIEJA="$SRV/.interfaz-vieja.$$"
	mv "$INTERFAZ_DESTINO" "$VIEJA"
	mv "$TMP_INTERFAZ" "$INTERFAZ_DESTINO"
	rm -rf "$VIEJA"
else
	mv "$TMP_INTERFAZ" "$INTERFAZ_DESTINO"
fi

chmod 0700 "$CURSOS" "$ARCHIVOS" "$RESPALDOS" "$ESPACIOS"
chmod 0755 "$PLATAFORMA"

copiar_carpeta() {
	local origen="$1" destino="$2" nombre
	shift 2
	nombre="$(basename "$destino")"
	local tmp
	tmp="$(mktemp -d "$PLATAFORMA/.$nombre.XXXXXX")"
	local excluir=()
	for e in "$@"; do
		excluir+=(--exclude "$e")
	done
	tar -C "$origen" "${excluir[@]}" -cf - . | tar -C "$tmp" -xf -
	chmod 0755 "$tmp"
	if [ -e "$destino" ]; then
		local vieja="$PLATAFORMA/.$nombre-vieja.$$"
		mv "$destino" "$vieja"
		mv "$tmp" "$destino"
		rm -rf "$vieja"
	else
		mv "$tmp" "$destino"
	fi
}

if [ -n "$PLANTILLA" ]; then
	copiar_carpeta "$PLANTILLA" "$PLANTILLA_DESTINO" node_modules ./dist
fi
if [ -n "$ESPACIO" ]; then
	copiar_carpeta "$ESPACIO" "$ESPACIO_DESTINO"
fi
if [ -n "$SDK" ]; then
	copiar_carpeta "$SDK" "$SDK_DESTINO" node_modules
fi

instalar_respaldo() {
	local tmp vieja guion unidad
	if [ -L "$DESPLIEGUE_DESTINO" ] || { [ -e "$DESPLIEGUE_DESTINO" ] && [ ! -d "$DESPLIEGUE_DESTINO" ]; }; then
		rm -f "$DESPLIEGUE_DESTINO"
	fi
	if [ ! -d "$DESPLIEGUE_DESTINO" ]; then
		tmp="$(mktemp -d "$PLATAFORMA/.despliegue.XXXXXX")"
		chmod 0750 "$tmp"
		mv -T "$tmp" "$DESPLIEGUE_DESTINO"
	fi
	chmod 0750 "$DESPLIEGUE_DESTINO"
	tmp="$(mktemp -d "$PLATAFORMA/.respaldo.XXXXXX")"
	for guion in respaldar.sh restaurar.sh; do
		cp "$AQUI/respaldo/$guion" "$tmp/$guion"
		chmod 0750 "$tmp/$guion"
	done
	chmod 0750 "$tmp"
	if [ "$SERVICIOS" = 1 ]; then
		chown root:campusia "$DESPLIEGUE_DESTINO" "$tmp" "$tmp/respaldar.sh" "$tmp/restaurar.sh"
	fi
	if [ -e "$RESPALDO_DESTINO" ] || [ -L "$RESPALDO_DESTINO" ]; then
		vieja="$PLATAFORMA/.respaldo-vieja.$$"
		rm -rf "$vieja"
		mv -T "$RESPALDO_DESTINO" "$vieja"
		mv -T "$tmp" "$RESPALDO_DESTINO"
		rm -rf "$vieja"
	else
		mv -T "$tmp" "$RESPALDO_DESTINO"
	fi
	for unidad in campusia-respaldo.service campusia-respaldo.timer; do
		tmp="$(mktemp "$UNIDADES_DIR/.$unidad.XXXXXX")"
		cp "$AQUI/respaldo/$unidad" "$tmp"
		chmod 0644 "$tmp"
		if [ "$SERVICIOS" = 1 ]; then
			chown root:root "$tmp"
		fi
		mv -f "$tmp" "$UNIDADES_DIR/$unidad"
	done
}

instalar_respaldo

instalar_australis() {
	local tmp vieja
	mkdir -p "$AUSTRALIS_DATOS" "$AUSTRALIS_ARCHIVOS"
	tmp="$(mktemp "$RAIZ/usr/local/bin/.australis-server.XXXXXX")"
	cp "$AUSTRALIS_BINARIO" "$tmp"
	chmod 0755 "$tmp"
	mv -f "$tmp" "$AUSTRALIS_BIN_DESTINO"
	tmp="$(mktemp -d "$AUSTRALIS/.frontend.XXXXXX")"
	cp -R "$AUSTRALIS_FRONTEND/." "$tmp/"
	chmod 0755 "$tmp"
	if [ -e "$AUSTRALIS_FRONTEND_DESTINO" ]; then
		vieja="$AUSTRALIS/.frontend-vieja.$$"
		mv "$AUSTRALIS_FRONTEND_DESTINO" "$vieja"
		mv "$tmp" "$AUSTRALIS_FRONTEND_DESTINO"
		rm -rf "$vieja"
	else
		mv "$tmp" "$AUSTRALIS_FRONTEND_DESTINO"
	fi
	chmod 0700 "$AUSTRALIS_ARCHIVOS"
	install -m 0644 "$AQUI/campusia-australis.service" "$AUSTRALIS_UNIDAD"
	if [ "$SERVICIOS" = 1 ]; then
		chown -R root:root "$AUSTRALIS_FRONTEND_DESTINO"
		chmod -R u=rwX,go=rX "$AUSTRALIS_FRONTEND_DESTINO"
		chown campusia:campusia "$AUSTRALIS" "$AUSTRALIS_DATOS" "$AUSTRALIS_ARCHIVOS"
		chmod 0751 "$AUSTRALIS"
		chmod 0750 "$AUSTRALIS_DATOS"
		find "$AUSTRALIS_DATOS" -maxdepth 1 -name 'australis.db*' -exec chown campusia:campusia {} +
		chown -R campusia:campusia "$AUSTRALIS_ARCHIVOS"
		chown campusia:campusia "$AUSTRALIS_ENTORNO"
		chmod 0600 "$AUSTRALIS_ENTORNO"
	fi
}

if [ -n "$AUSTRALIS_BINARIO" ]; then
	instalar_australis
fi

install -m 0644 "$AQUI/campusia-nucleo.service" "$UNIDAD_DESTINO"
install -m 0644 "$AQUI/Caddyfile" "$CADDY_DESTINO"

if [ "$SERVICIOS" = 1 ]; then
	chown -R root:root "$INTERFAZ_DESTINO"
	chmod -R u=rwX,go=rX "$INTERFAZ_DESTINO"
	chown campusia:campusia "$SRV" "$DATOS" "$CONFIG" "$CURSOS" "$ARCHIVOS" "$RESPALDOS" "$ESPACIOS"
	chown root:campusia "$PLATAFORMA"
	chmod 0750 "$PLATAFORMA"
	if [ -d "$PLANTILLA_DESTINO" ]; then
		chown -R root:campusia "$PLANTILLA_DESTINO"
		chmod -R u=rwX,g=rX,o= "$PLANTILLA_DESTINO"
	fi
	if [ -d "$ESPACIO_DESTINO" ]; then
		chown -R root:campusia "$ESPACIO_DESTINO"
		chmod -R u=rwX,g=rX,o= "$ESPACIO_DESTINO"
	fi
	if [ -d "$SDK_DESTINO" ]; then
		chown -R campusia:campusia "$SDK_DESTINO"
		chmod -R u=rwX,g=rX,o= "$SDK_DESTINO"
	fi
	chmod 0750 "$SRV" "$DATOS" "$CONFIG"
	chown campusia:campusia "$ENTORNO_ARCHIVO"
	chmod 0600 "$ENTORNO_ARCHIVO"
	find "$DATOS" -maxdepth 1 -name 'campusia.db*' -exec chown campusia:campusia {} +
	if command -v runuser >/dev/null; then
		runuser -u campusia -- env DATABASE_URL="sqlite://$BASE" "$BIN_DESTINO" migrar
	else
		su -s /bin/sh campusia -c "DATABASE_URL='sqlite://$BASE' '$BIN_DESTINO' migrar"
	fi
else
	DATABASE_URL="sqlite://$BASE" "$BIN_DESTINO" migrar
fi

[ -f "$BASE" ] || falla "la migración no creó $BASE"

if [ "$SERVICIOS" = 1 ]; then
	systemctl daemon-reload
	systemctl enable --now campusia-respaldo.timer
	systemctl enable campusia-nucleo.service
	if [ -n "$AUSTRALIS_BINARIO" ]; then
		systemctl enable campusia-australis.service
		systemctl restart campusia-nucleo.service campusia-australis.service
	else
		systemctl restart campusia-nucleo.service
	fi
	if command -v caddy >/dev/null; then
		caddy validate --config "$CADDY_DESTINO" --adapter caddyfile
	fi
	if systemctl is-active --quiet caddy; then
		systemctl reload caddy
	else
		systemctl enable --now caddy
	fi
	PUERTO_SALUD="$(sed -n 's/^PUERTO=\([0-9]*\).*/\1/p' "$ENTORNO_ARCHIVO" | tail -n 1)"
	PUERTO_SALUD="${PUERTO_SALUD:-8080}"
	NUCLEO_SANO=0
	for i in $(seq 1 120); do
		if curl -fsS --max-time 3 "http://127.0.0.1:$PUERTO_SALUD/salud" >/dev/null 2>&1; then
			NUCLEO_SANO=1
			break
		fi
		sleep 1
	done
	if [ "$NUCLEO_SANO" = 0 ]; then
		systemctl --no-pager status campusia-nucleo.service >&2 || true
		journalctl --no-pager -u campusia-nucleo.service -n 40 -o cat >&2 || true
		falla "campusia-nucleo no respondió en /salud"
	fi
	if [ -z "$AUSTRALIS_BINARIO" ]; then
		echo "campusia-nucleo instalado y sano"
		exit 0
	fi
	for i in $(seq 1 120); do
		if curl -fsS --max-time 3 "http://127.0.0.1:$AUSTRALIS_PUERTO/api/health" >/dev/null 2>&1; then
			echo "campusia-nucleo y campusia-australis instalados y sanos"
			exit 0
		fi
		sleep 1
	done
	systemctl --no-pager status campusia-australis.service >&2 || true
	journalctl --no-pager -u campusia-australis.service -n 40 -o cat >&2 || true
	falla "campusia-australis no respondió en /api/health"
fi

if [ -n "$AUSTRALIS_BINARIO" ]; then
	echo "campusia-nucleo y campusia-australis instalados en ${RAIZ:-/}"
else
	echo "campusia-nucleo instalado en ${RAIZ:-/}"
fi
