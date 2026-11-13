#!/bin/bash
/usr/local/lib/sustitutos/registrar-como dockerd-rootless-setuptool.sh "$@"
if [ "$(id -u)" -eq 0 ]; then echo "no se corre como root" >&2; exit 1; fi
exit 0
