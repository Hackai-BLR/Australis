#!/usr/bin/env bash
set -uo pipefail
umask 077

AQUI="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO="$(cd "$AQUI/.." && pwd)"
SERVIDOR_DIR="$AQUI/servidor"
CLOUDFLARE_DIR="$AQUI/cloudflare"
RESTAURAR_SH="$REPO/despliegue/respaldo/restaurar.sh"
PROGRAMAS=(ssh scp ansible-playbook ansible-galaxy tofu git sha256sum)
OCTETO='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
RUTA_SEGURA='^[^[:space:]"'"'"'\\$`;|&<>*?]+$'

TOKEN="${CLOUDFLARE_API_TOKEN-}"
FRASE="${TOFU_FRASE_ESTADO-}"
VAULT_CONTRASENA="${ANSIBLE_VAULT_CONTRASENA-}"
TOKEN_DEFINIDO="${CLOUDFLARE_API_TOKEN+si}"
FRASE_DEFINIDA="${TOFU_FRASE_ESTADO+si}"
CONTRASENA_DEFINIDA="${ANSIBLE_VAULT_CONTRASENA+si}"
unset CLOUDFLARE_API_TOKEN TOFU_FRASE_ESTADO ANSIBLE_VAULT_CONTRASENA TF_VAR_cloudflare_api_token TF_VAR_frase_estado
unset ANSIBLE_VAULT_PASSWORD_FILE ANSIBLE_VAULT_IDENTITY_LIST

TEMPORAL=""
PASO=""
ACTUAL_INICIAL=""

limpiar() {
  if [ -n "$TEMPORAL" ] && [ -d "$TEMPORAL" ]; then
    rm -rf -- "$TEMPORAL"
  fi
}
trap limpiar EXIT
trap 'exit 130' INT TERM HUP

decir() {
  printf 'levantar: %s\n' "$*"
}

invalido() {
  decir "$*" >&2
  decir "falló el paso verificar"
  exit 2
}

fallar() {
  decir "$*" >&2
  return 1
}

encabezado() {
  PASO="$2"
  printf '==> [%s/5] %s\n' "$1" "$2"
}

absoluta() {
  realpath -m -- "$1"
}

validar() {
  local p

  IP="${CAMPUSIA_IP-}"
  [ -n "$IP" ] || invalido "falta CAMPUSIA_IP"
  [[ "$IP" =~ ^$OCTETO\.$OCTETO\.$OCTETO\.$OCTETO$ ]] || invalido "CAMPUSIA_IP tiene que ser una IPv4 literal (cuatro octetos de 0 a 255)"

  USUARIO="${CAMPUSIA_SSH_USUARIO:-root}"
  [[ "$USUARIO" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || invalido "CAMPUSIA_SSH_USUARIO inválido (se espera ^[a-z_][a-z0-9_-]{0,31}\$)"

  PUERTO="${CAMPUSIA_SSH_PUERTO:-22}"
  if ! [[ "$PUERTO" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$PUERTO" -gt 65535 ]; then
    invalido "CAMPUSIA_SSH_PUERTO tiene que ser un entero de 1 a 65535"
  fi

  CLAVE=""
  if [ -n "${CAMPUSIA_SSH_CLAVE-}" ]; then
    [[ "$CAMPUSIA_SSH_CLAVE" =~ $RUTA_SEGURA ]] || invalido "CAMPUSIA_SSH_CLAVE tiene caracteres no permitidos"
    [ -f "$CAMPUSIA_SSH_CLAVE" ] && [ -r "$CAMPUSIA_SSH_CLAVE" ] || invalido "CAMPUSIA_SSH_CLAVE no es un archivo legible: $CAMPUSIA_SSH_CLAVE"
    CLAVE="$(absoluta "$CAMPUSIA_SSH_CLAVE")"
  fi

  if [ -n "${CAMPUSIA_KNOWN_HOSTS-}" ]; then
    KNOWN_HOSTS="$CAMPUSIA_KNOWN_HOSTS"
  else
    [ -n "${HOME-}" ] || invalido "falta HOME para el defecto de CAMPUSIA_KNOWN_HOSTS"
    KNOWN_HOSTS="$HOME/.config/campusia/known_hosts"
  fi
  [[ "$KNOWN_HOSTS" =~ $RUTA_SEGURA ]] || invalido "CAMPUSIA_KNOWN_HOSTS tiene caracteres no permitidos"
  if [ -e "$KNOWN_HOSTS" ] && [ ! -f "$KNOWN_HOSTS" ]; then
    invalido "CAMPUSIA_KNOWN_HOSTS no es un archivo: $KNOWN_HOSTS"
  fi
  KNOWN_HOSTS="$(absoluta "$KNOWN_HOSTS")"

  [ "$TOKEN_DEFINIDO" = si ] || invalido "falta CLOUDFLARE_API_TOKEN"
  [ -n "$TOKEN" ] || invalido "CLOUDFLARE_API_TOKEN está vacía"
  [[ "$TOKEN" != *$'\n'* ]] || invalido "CLOUDFLARE_API_TOKEN tiene saltos de línea"

  [ "$FRASE_DEFINIDA" = si ] || invalido "falta TOFU_FRASE_ESTADO"
  [ -n "$FRASE" ] || invalido "TOFU_FRASE_ESTADO está vacía"
  [ "${#FRASE}" -ge 16 ] || invalido "TOFU_FRASE_ESTADO tiene que tener 16 caracteres o más"
  [[ "$FRASE" != *$'\n'* ]] || invalido "TOFU_FRASE_ESTADO tiene saltos de línea"

  [ "$CONTRASENA_DEFINIDA" = si ] || invalido "falta ANSIBLE_VAULT_CONTRASENA"
  [ -n "$VAULT_CONTRASENA" ] || invalido "ANSIBLE_VAULT_CONTRASENA está vacía"
  [[ "$VAULT_CONTRASENA" != *$'\n'* ]] || invalido "ANSIBLE_VAULT_CONTRASENA tiene saltos de línea"

  VAULT="${CAMPUSIA_VAULT_ARCHIVO:-$SERVIDOR_DIR/secretos.vault.yml}"
  [ -f "$VAULT" ] && [ -r "$VAULT" ] || invalido "CAMPUSIA_VAULT_ARCHIVO no existe o no se puede leer: $VAULT"
  [ "$(head -c 15 -- "$VAULT")" = '$ANSIBLE_VAULT;' ] || invalido "CAMPUSIA_VAULT_ARCHIVO no está cifrado con Ansible Vault (tiene que empezar con \$ANSIBLE_VAULT;)"
  VAULT="$(absoluta "$VAULT")"

  TFVARS="${CAMPUSIA_TFVARS:-$CLOUDFLARE_DIR/produccion.tfvars}"
  [ -f "$TFVARS" ] && [ -r "$TFVARS" ] || invalido "CAMPUSIA_TFVARS no existe o no se puede leer: $TFVARS"
  TFVARS="$(absoluta "$TFVARS")"

  RESPALDO_TAR=""
  RESPALDO_SUMA=""
  if [ -n "${CAMPUSIA_RESPALDO-}" ]; then
    if [ -d "$CAMPUSIA_RESPALDO" ]; then
      RESPALDO_TAR="$CAMPUSIA_RESPALDO/respaldo.tar.gz"
    elif [ -f "$CAMPUSIA_RESPALDO" ]; then
      RESPALDO_TAR="$CAMPUSIA_RESPALDO"
    else
      invalido "CAMPUSIA_RESPALDO no existe: $CAMPUSIA_RESPALDO"
    fi
    [ -f "$RESPALDO_TAR" ] && [ -r "$RESPALDO_TAR" ] || invalido "CAMPUSIA_RESPALDO no tiene respaldo.tar.gz: $RESPALDO_TAR"
    RESPALDO_SUMA="$RESPALDO_TAR.sha256"
    [ -f "$RESPALDO_SUMA" ] && [ -r "$RESPALDO_SUMA" ] || invalido "CAMPUSIA_RESPALDO no tiene la suma al lado: $RESPALDO_SUMA"
    [ -f "$RESTAURAR_SH" ] || invalido "CAMPUSIA_RESPALDO necesita $RESTAURAR_SH"
    RESPALDO_TAR="$(absoluta "$RESPALDO_TAR")"
    RESPALDO_SUMA="$(absoluta "$RESPALDO_SUMA")"
  fi

  EXTRA=""
  if [ -n "${CAMPUSIA_ANSIBLE_EXTRA-}" ]; then
    [ -f "$CAMPUSIA_ANSIBLE_EXTRA" ] && [ -r "$CAMPUSIA_ANSIBLE_EXTRA" ] || invalido "CAMPUSIA_ANSIBLE_EXTRA no existe o no se puede leer: $CAMPUSIA_ANSIBLE_EXTRA"
    EXTRA="$(absoluta "$CAMPUSIA_ANSIBLE_EXTRA")"
  fi

  ESPERA="${LEVANTAR_ESPERA_DESPLIEGUE:-3600}"
  [[ "$ESPERA" =~ ^[0-9]{1,7}$ ]] || invalido "LEVANTAR_ESPERA_DESPLIEGUE tiene que ser un número de segundos"
  ESPERA=$((10#$ESPERA))

  for p in "${PROGRAMAS[@]}"; do
    command -v "$p" >/dev/null 2>&1 || invalido "falta el programa $p en el PATH"
  done
  [ -f "$SERVIDOR_DIR/sitio.yml" ] || invalido "falta $SERVIDOR_DIR/sitio.yml"
  [ -f "$SERVIDOR_DIR/requirements.yml" ] || invalido "falta $SERVIDOR_DIR/requirements.yml"

  if [ "$USUARIO" = root ]; then
    SUDO=""
  else
    SUDO="sudo -n "
  fi

  SSH_OPCIONES=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6
    -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS")
  if [ -n "$CLAVE" ]; then
    SSH_OPCIONES+=(-o IdentitiesOnly=yes -i "$CLAVE")
  fi
  DESTINO="$USUARIO@$IP"
}

remoto() {
  ssh "${SSH_OPCIONES[@]}" -p "$PUERTO" "$DESTINO" "$@"
}

copiar() {
  scp -q "${SSH_OPCIONES[@]}" -P "$PUERTO" "$1" "$DESTINO:$2"
}

paso_verificar() {
  validar
  TEMPORAL="$(mktemp -d "${TMPDIR:-/tmp}/campusia-levantar.XXXXXX")" || fallar "no se pudo crear la carpeta temporal" || return 1
  mkdir -p -- "$(dirname -- "$KNOWN_HOSTS")" || fallar "no se pudo crear la carpeta de CAMPUSIA_KNOWN_HOSTS" || return 1
  if ! remoto true </dev/null; then
    fallar "no hay conexión SSH con $DESTINO en el puerto $PUERTO"
    return 1
  fi
  if [ -n "$SUDO" ] && ! remoto "sudo -n true" </dev/null; then
    fallar "$USUARIO no puede usar sudo sin contraseña en $IP"
    return 1
  fi
  ACTUAL_INICIAL="$(remoto "${SUDO}cat /srv/campusia/despliegue/actual 2>/dev/null; true" </dev/null | tr -dc '0-9a-f')"
  printf 'verificar: %s puerto %s\n' "$DESTINO" "$PUERTO"
}

paso_ansible() {
  local inventario="$TEMPORAL/inventario.yml"
  local contrasena="$TEMPORAL/vault-contrasena"
  local salida="$TEMPORAL/ansible.log"
  local argumentos codigo cambios

  (cd "$SERVIDOR_DIR" && ansible-galaxy collection install -r requirements.yml) </dev/null || {
    fallar "ansible-galaxy no pudo instalar las colecciones"
    return 1
  }

  {
    printf '{"servidores": {"hosts": {"%s": {\n' "$IP"
    printf '  "ansible_host": "%s",\n' "$IP"
    printf '  "ansible_user": "%s",\n' "$USUARIO"
    printf '  "ansible_port": %s,\n' "$PUERTO"
    if [ -n "$CLAVE" ]; then
      printf '  "ansible_ssh_private_key_file": "%s",\n' "$CLAVE"
    fi
    if [ "$USUARIO" != root ]; then
      printf '  "ansible_become": true,\n  "ansible_become_method": "sudo",\n'
    fi
    printf '  "ansible_ssh_common_args": "-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s%s"\n' \
      "$KNOWN_HOSTS" "$([ -n "$CLAVE" ] && printf ' -o IdentitiesOnly=yes')"
    printf '}}}}\n'
  } >"$inventario"

  : >"$contrasena"
  chmod 600 "$contrasena"
  printf '%s\n' "$VAULT_CONTRASENA" >"$contrasena"

  argumentos=(-i "$inventario" sitio.yml -e "@$VAULT" --vault-password-file "$contrasena")
  if [ -n "$EXTRA" ]; then
    argumentos+=(-e "@$EXTRA")
  fi
  (cd "$SERVIDOR_DIR" && ANSIBLE_RETRY_FILES_ENABLED=False ansible-playbook "${argumentos[@]}") </dev/null 2>&1 | tee "$salida"
  codigo="${PIPESTATUS[0]}"
  rm -f -- "$contrasena"
  if [ "$codigo" -ne 0 ]; then
    fallar "ansible-playbook salió con $codigo"
    return 1
  fi
  cambios="$(sed -n "s/^${IP//./\\.}[[:space:]]*:.*changed=\([0-9]*\).*/\1/p" "$salida" | tail -n 1)"
  printf 'ansible: changed=%s\n' "${cambios:-?}"
}

GUION_DESPLEGAR='
{
set -uo pipefail
RAMA="$1"
ESPERA="$2"
USUARIO=campusia
RAIZ=/srv/campusia
DIR="$RAIZ/despliegue"
UIDC="$(id -u "$USUARIO")" || { echo "no existe el usuario $USUARIO" >&2; exit 1; }
VARIABLES=()
if [ -f "$RAIZ/config/continuo.env" ]; then
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%$'"'"'\r'"'"'}"
    [[ "$linea" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    VARIABLES+=("$linea")
  done <"$RAIZ/config/continuo.env"
fi
como_campusia() {
  (cd / && runuser -u "$USUARIO" -- env -i HOME="$RAIZ" USER="$USUARIO" LOGNAME="$USUARIO" SHELL=/bin/bash \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
    XDG_RUNTIME_DIR="/run/user/$UIDC" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UIDC/bus" \
    "${VARIABLES[@]}" "$@")
}
[ -x "$DIR/bin/desplegar.sh" ] || { echo "falta $DIR/bin/desplegar.sh" >&2; exit 1; }
LIMITE=$((SECONDS + ESPERA))
while true; do
  como_campusia "$DIR/bin/desplegar.sh" --forzar >&2
  CODIGO=$?
  [ "$CODIGO" -eq 75 ] || break
  if [ "$SECONDS" -ge "$LIMITE" ]; then
    echo "el cerrojo del despliegue siguió ocupado más de $ESPERA segundos" >&2
    exit 1
  fi
  echo "hay otro despliegue en curso; se reintenta en 10 segundos" >&2
  sleep 10
done
if [ "$CODIGO" -ne 0 ]; then
  echo "desplegar.sh salió con $CODIGO" >&2
  if [ -f "$DIR/registro.log" ]; then tail -n 3 "$DIR/registro.log" >&2; fi
  exit 1
fi
ACTUAL="$(tr -d "[:space:]" <"$DIR/actual" 2>/dev/null)"
ESPERADO="$(como_campusia git --git-dir="$DIR/repo.git" rev-parse -q --verify "refs/heads/$RAMA^{commit}" 2>/dev/null)"
if ! [[ "$ACTUAL" =~ ^[0-9a-f]{40}$ ]] || [ "$ACTUAL" != "$ESPERADO" ]; then
  echo "la versión desplegada ($ACTUAL) no es la de $RAMA ($ESPERADO)" >&2
  exit 1
fi
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/salud >/dev/null 2>&1; then
    printf "\nCOMMIT=%s\n" "$ACTUAL"
    exit 0
  fi
  sleep 1
done
echo "el núcleo no responde en /salud" >&2
exit 1
} </dev/null
'

paso_desplegar() {
  local rama salida commit
  rama="$(remoto "${SUDO}sed -n 's/^DESPLIEGUE_RAMA=//p' /srv/campusia/config/continuo.env" </dev/null | tail -n 1 | tr -d '\r')"
  rama="${rama:-main}"
  if ! [[ "$rama" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
    fallar "rama de despliegue inválida en continuo.env"
    return 1
  fi
  salida="$(printf '%s' "$GUION_DESPLEGAR" | remoto "${SUDO}bash -s -- $rama $ESPERA")" || {
    fallar "el despliegue no terminó bien"
    return 1
  }
  commit="$(printf '%s\n' "$salida" | sed -n 's/^COMMIT=\([0-9a-f]\{40\}\)$/\1/p' | tail -n 1)"
  if [ -z "$commit" ]; then
    fallar "el despliegue no informó el commit"
    return 1
  fi
  if [ "$commit" = "$ACTUAL_INICIAL" ]; then
    printf 'desplegar: sin cambios %s\n' "$commit"
  else
    printf 'desplegar: %s\n' "$commit"
  fi
}

GUION_RESTAURAR='
{
set -uo pipefail
CARPETA="$1"
SUMA="$2"
MARCA=/srv/campusia/config/restaurado
trap "rm -rf -- \"$CARPETA\"" EXIT
case "$CARPETA" in
  /root/.campusia-levantar.*|/tmp/campusia-levantar.*) ;;
  *) echo "carpeta temporal inesperada" >&2; exit 1 ;;
esac
[[ "$SUMA" =~ ^[0-9a-f]{64}$ ]] || { echo "suma inválida" >&2; exit 1; }
chown -R root:root -- "$CARPETA"
chmod 700 -- "$CARPETA"
CAMPUSIA_SERVICIO=campusia-nucleo.service bash "$CARPETA/restaurar.sh" "$CARPETA"
CODIGO=$?
if [ "$CODIGO" -ne 0 ]; then
  echo "restaurar.sh salió con $CODIGO" >&2
  exit "$CODIGO"
fi
NUEVA="$(mktemp "$MARCA.XXXXXX")" || exit 1
printf "%s\n" "$SUMA" >"$NUEVA"
chown root:root -- "$NUEVA"
chmod 600 -- "$NUEVA"
mv -f -- "$NUEVA" "$MARCA"
systemctl start campusia-nucleo.service >/dev/null 2>&1 || true
for i in $(seq 1 90); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/salud >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo "el núcleo no responde en /salud después de restaurar" >&2
exit 1
} </dev/null
'

paso_restaurar() {
  local suma previa carpeta
  if [ -z "$RESPALDO_TAR" ]; then
    printf 'restaurar: omitido\n'
    return 0
  fi
  suma="$(sha256sum -- "$RESPALDO_TAR" | cut -d' ' -f1)"
  if ! [[ "$suma" =~ ^[0-9a-f]{64}$ ]]; then
    fallar "no se pudo calcular la suma de $RESPALDO_TAR"
    return 1
  fi
  previa="$(remoto "${SUDO}cat /srv/campusia/config/restaurado 2>/dev/null; true" </dev/null | tr -dc '0-9a-f')"
  if [ "$previa" = "$suma" ]; then
    printf 'restaurar: ya restaurado\n'
    return 0
  fi
  if [ -z "$SUDO" ]; then
    carpeta="$(remoto "mktemp -d /root/.campusia-levantar.XXXXXX" </dev/null | tr -d '\r')"
  else
    carpeta="$(remoto "mktemp -d /tmp/campusia-levantar.XXXXXX" </dev/null | tr -d '\r')"
  fi
  if ! [[ "$carpeta" =~ ^(/root/\.campusia-levantar\.|/tmp/campusia-levantar\.)[A-Za-z0-9]+$ ]]; then
    fallar "no se pudo crear la carpeta temporal en el servidor"
    return 1
  fi
  if ! copiar "$RESPALDO_TAR" "$carpeta/respaldo.tar.gz" </dev/null \
    || ! copiar "$RESPALDO_SUMA" "$carpeta/respaldo.tar.gz.sha256" </dev/null \
    || ! copiar "$RESTAURAR_SH" "$carpeta/restaurar.sh" </dev/null; then
    remoto "${SUDO}rm -rf -- $carpeta" </dev/null || true
    fallar "no se pudo copiar el respaldo al servidor"
    return 1
  fi
  if ! printf '%s' "$GUION_RESTAURAR" | remoto "${SUDO}bash -s -- $carpeta $suma"; then
    fallar "la restauración falló; los datos del servidor quedaron como estaban"
    return 1
  fi
  printf 'restaurar: %s\n' "$suma"
}

paso_dns() {
  local datos="$TEMPORAL/tofu"
  mkdir -p -- "$datos"
  if ! TF_DATA_DIR="$datos" TF_IN_AUTOMATION=1 TF_VAR_cloudflare_api_token="$TOKEN" TF_VAR_frase_estado="$FRASE" \
    tofu -chdir="$CLOUDFLARE_DIR" init -input=false </dev/null; then
    fallar "tofu init falló"
    return 1
  fi
  if ! TF_DATA_DIR="$datos" TF_IN_AUTOMATION=1 TF_VAR_cloudflare_api_token="$TOKEN" TF_VAR_frase_estado="$FRASE" \
    tofu -chdir="$CLOUDFLARE_DIR" apply -input=false -auto-approve -var-file="$TFVARS" -var "ip_servidor=$IP" \
    -target='cloudflare_dns_record.registros["apex"]' -target='cloudflare_dns_record.registros["comodin"]' </dev/null; then
    fallar "tofu apply falló"
    return 1
  fi
  printf 'dns: %s\n' "$IP"
}

correr_paso() {
  encabezado "$1" "$2"
  if ! "paso_$2"; then
    decir "falló el paso $2"
    exit 1
  fi
}

correr_paso 1 verificar
correr_paso 2 ansible
correr_paso 3 desplegar
correr_paso 4 restaurar
correr_paso 5 dns
decir "listo"
exit 0
