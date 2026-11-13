#!/bin/bash
set -u
mkdir -p /usr/local/lib/sustitutos /salida
install -m 755 /sustitutos/registrar-como /usr/local/lib/sustitutos/registrar-como
for f in apt-get curl systemctl loginctl dockerd-rootless-setuptool.sh docker; do
  install -m 755 "/sustitutos/$f" "/usr/local/bin/$f"
done
: > /var/log/sustitutos.log
chmod 666 /var/log/sustitutos.log
touch /etc/subuid /etc/subgid
if [ "${SIN_USUARIO:-0}" != 1 ]; then
  useradd -m -d /srv/campusia -s /bin/bash campusia
  sed -i '/^campusia:/d' /etc/subuid /etc/subgid
  if [ "${SIN_SUBUID:-0}" != 1 ]; then
    echo "campusia:100000:65536" >> /etc/subuid
    echo "campusia:100000:65536" >> /etc/subgid
  fi
  uid="$(id -u campusia)"
  mkdir -p "/run/user/$uid"
  chown campusia:campusia "/run/user/$uid"
  chmod 700 "/run/user/$uid"
  echo "$uid" > /salida/uid
  if [ "${EN_GRUPO_DOCKER:-0}" = 1 ]; then
    groupadd docker
    usermod -aG docker campusia
  fi
  if [ "${CON_LINGER:-0}" = 1 ]; then
    mkdir -p /var/lib/systemd/linger
    touch /var/lib/systemd/linger/campusia
  fi
fi
for n in $(seq 1 "${CORRIDAS:-2}"); do
  if [ "${COMO_CAMPUSIA:-0}" = 1 ]; then
    runuser -u campusia -- bash /despliegue/preparar-docker.sh > "/salida/corrida$n.out" 2>&1
  else
    bash /despliegue/preparar-docker.sh > "/salida/corrida$n.out" 2>&1
  fi
  echo "$?" > "/salida/codigo$n"
  mkdir -p "/salida/estado$n"
  for d in /etc/apt/sources.list.d /etc/apt/keyrings /etc/systemd/system /var/lib/systemd/linger; do
    if [ -d "$d" ]; then
      mkdir -p "/salida/estado$n$d"
      cp -a "$d/." "/salida/estado$n$d/"
    fi
  done
  cp /var/log/sustitutos.log "/salida/log$n"
done
if id campusia >/dev/null 2>&1; then id -nG campusia > /salida/grupos; fi
chmod -R a+rwX /salida
tar -C /salida -cf - .
