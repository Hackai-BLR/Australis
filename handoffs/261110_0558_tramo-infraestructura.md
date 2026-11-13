# Tramo infraestructura como código

_Creado: 2026-11-10 05:58. Tramo paralelo en la rama `tramo-infraestructura`. Alcance: `.orquestacion/tramo-infraestructura.md`. Contrato: `contratos/tramo-infraestructura.md`._

## 1. Qué se hizo

La infraestructura que ya existía (creada a mano y por API) quedó descripta como código, sin recrearla, y se agregó el despliegue continuo que corre en el propio servidor. No hay credenciales reales en el entorno de desarrollo: todo se validó y se probó sin ellas.

| Ruta | Contenido |
|---|---|
| `infraestructura/cloudflare/` | OpenTofu con el proveedor oficial `cloudflare/cloudflare` 5.x: DNS (apex y comodín con proxy, DKIM y código de Brevo, DMARC, SPF), reenvío de correo y regla `hola@`, ajustes de zona (SSL `strict`, `always_use_https`, TLS 1.2), widget de Turnstile `campusia-login`, certificado de origen ECC de 15 años con `prevent_destroy`. Bloques `import` con `for_each` sobre `var.ids_existentes`. Estado local en `estado/terraform.tfstate`, cifrado nativo (`pbkdf2` + `aes_gcm`, `enforced = true`). `tofu.sh` lee el token y la frase de `~/.config/campusia/`. `.terraform.lock.hcl` versionado |
| `infraestructura/servidor/` | Ansible con los roles `base`, `usuario`, `ssh`, `firewall`, `swap`, `caddy`, `docker` y `campusia`, idempotentes y con verificación al final de cada uno. `secretos.ejemplo.yml` con las claves del Vault y valores ficticios; `campusia.env` se genera desde el Vault con `no_log` |
| `infraestructura/README.md` | Herramientas, secretos locales, Vault, inventario, cómo importar lo existente (formato de cada id de `ids_existentes`) y el orden para levantar todo desde cero |
| `despliegue/continuo/` | `desplegar.sh` (cerrojo, espejo del repo, checkout limpio por commit, pruebas, compilación, instalación, salud y vuelta atrás), `receptor.py` del webhook (HMAC SHA-256, solo push a `main` del repo esperado, sin repeticiones), `limpiar.sh` (caché con tope de tamaño y edad, fuentes e imágenes, conserva 3 versiones), `registro.sh`, `preparar-continuo.sh`, unidades de usuario de systemd, imagen de compilación y `continuo.env.ejemplo` |
| `contratos/tramo-infraestructura.md` | Contrato del tramo |
| `pruebas/tramo-infraestructura/` | Pruebas de aceptación y de ataque con pytest, imagen Debian 13 con systemd y `correr.sh` |

## 2. Cómo se compila, se levanta, se prueba y se despliega

No hay compilación. Las herramientas se instalan sin sudo.

Pruebas, desde cero y sin pasos manuales (10 a 20 minutos; conviene en segundo plano):

```
bash pruebas/tramo-infraestructura/correr.sh
```

Descarga OpenTofu 1.10.7 con verificación de suma, crea con `uv` el entorno de Python en `pruebas/tramo-infraestructura/.herramientas/` (ignorado por git) con `ansible-core`, `ansible-lint` y `pytest`, instala las colecciones, construye la imagen `campusia-pruebas-debian13-systemd` y corre pytest. `CONSERVAR_CONTENEDORES=1` deja los contenedores; `-k <expresión>` elige un subconjunto.

Comprobaciones rápidas:

```
cd infraestructura/servidor && ansible-lint --offline --profile moderate
cd infraestructura/cloudflare && tofu fmt -check && tofu init -backend=false && tofu validate
```

Producción (quien tiene las credenciales, detallado en `infraestructura/README.md`):

```
cd infraestructura/cloudflare && ./tofu.sh init && ./tofu.sh plan -var-file=produccion.tfvars
cd infraestructura/servidor && ansible-galaxy collection install -r requirements.yml && ansible-playbook -i inventario.yml sitio.yml --vault-password-file ~/.config/campusia/vault-pass
```

Para importar lo existente se completa `ids_existentes` en `produccion.tfvars`, se revisa que el plan no tenga cambios destructivos, se aplica y se versiona `estado/terraform.tfstate` (cifrado). Después: deploy key de solo lectura en el servidor, webhook de GitHub hacia `https://campusia.tech/_despliegue/webhook` con el secreto de `vault_secreto_webhook`, y primer despliegue con `systemctl --user start campusia-despliegue.service` como `campusia`. El temporizador de 5 minutos despliega aunque el webhook no esté configurado.

## 3. Decisiones

- Estado de OpenTofu local, cifrado y versionado en git, sin respaldo sin cifrar: leer o escribir estado sin cifrar falla. Mientras nadie aplique con credenciales reales la carpeta solo tiene `.gitkeep`.
- Los MX y el DKIM del reenvío de correo no se declaran como registros sueltos: los gestiona `cloudflare_email_routing_dns`, porque Cloudflare elige prioridades y clave.
- El certificado de origen ignora cambios en `csr` y `requested_validity` y tiene `prevent_destroy`; el rol `caddy` nunca reemplaza una clave o un certificado existentes y, en un servidor nuevo, genera la clave y la CSR allí.
- Firewall: conjuntos `cloudflare_v4` y `cloudflare_v6` en `inet filtro`; `campusia-cloudflare-ips` rechaza listas vacías, redes inválidas y prefijos más cortos que `/8` o `/16` y aplica todo en una sola transacción. Lo corre un temporizador semanal.
- El despliegue continuo usa unidades de usuario de `campusia` con linger y Docker sin root; las etapas son comandos configurables por variables, lo que permite probarlo con un proyecto de prueba.
- Las pruebas no usan `--privileged`: `servidor_contenedor_de_prueba` evita `swapon`, `sysctl` en vivo y el arranque de Docker sin root dentro del contenedor, y verifica la configuración escrita.
- Los roles `docker` y `campusia` invocan `despliegue/docker/preparar-docker.sh` y `despliegue/continuo/preparar-continuo.sh` si existen; `caddy` instala `despliegue/Caddyfile` si existe y si no deja uno mínimo con la ruta del webhook.

## 4. Desvíos del plan

- No hay `infraestructura/levantar.sh`: el levantado desde cero es la secuencia documentada en `infraestructura/README.md` (Ansible, certificado, deploy key, webhook, primer despliegue, DNS), no un único comando. Tampoco está el paso de restauración de datos desde un respaldo.
- La prueba de punta a punta corre solo contra Debian 13. El rol `docker` elige el repositorio oficial según la distribución detectada y el README declara Debian 12 y 13 y Ubuntu 22.04 y 24.04, pero Ubuntu 24.04 no se probó.
- `despliegue/instalar.sh`, `despliegue/Caddyfile` y `despliegue/docker/preparar-docker.sh` son de otro tramo. Mientras no exista `instalar.sh` en `main`, un despliegue real queda en `fallo-instalacion`.

## 5. Resultado de las pruebas

Última corrida completa de `bash pruebas/tramo-infraestructura/correr.sh` (9 min 13 s, 109 pruebas, código de salida 0):

- aceptación: 39/39
- ataque: 70/70

## 6. Pendientes conocidos

- Quien tiene las credenciales: crear `~/.config/campusia/` (token de Cloudflare, frase del estado, contraseña del Vault), `secretos.vault.yml` cifrado, `produccion.tfvars` con `correo_destino_reenvio`, `csr_origen` e `ids_existentes`, correr `./tofu.sh plan`, importar, aplicar y versionar el estado cifrado.
- Crear la deploy key del servidor y el webhook de GitHub.
- Escribir `infraestructura/levantar.sh` que encadene todo con variables de entorno, incluida la restauración opcional de un respaldo.
- Agregar a `correr.sh` una corrida contra Ubuntu 24.04.
- Mostrar `registro.log` en el panel de owner ("Uso y proveedores") en una fase posterior; hoy se consulta con `registro.sh` por SSH.
- Integrar con `despliegue/instalar.sh` y el Caddyfile definitivo cuando el otro tramo los suba, y volver a correr las pruebas.
