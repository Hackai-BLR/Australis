#!/usr/local/bin/node
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/repo';
const DISPOSITIVOS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/urandom', '/dev/random', '/dev/tty']);
const PROTEGIDOS_RAIZ = new Set(['vendor', 'Containerfile', '.containerignore', '.dockerignore', '.gitignore', 'CLAUDE.md', '.claude']);
const PROTEGIDOS_NOMBRE = new Set(['.git', '.claude', 'CLAUDE.md', '.gitignore', '.dockerignore', '.containerignore', 'Containerfile']);
const HERRAMIENTAS_DE_ARCHIVO = {
  Read: { campos: ['file_path'], escribe: false },
  Edit: { campos: ['file_path'], escribe: true },
  MultiEdit: { campos: ['file_path'], escribe: true },
  Write: { campos: ['file_path'], escribe: true },
  NotebookEdit: { campos: ['notebook_path'], escribe: true },
  NotebookRead: { campos: ['notebook_path'], escribe: false },
  Glob: { campos: ['path'], escribe: false, patrones: ['pattern'] },
  Grep: { campos: ['path'], escribe: false, patrones: ['glob'] },
  LS: { campos: ['path'], escribe: false },
};
const HERRAMIENTAS_PROHIBIDAS = new Set(['WebFetch', 'WebSearch', 'Task', 'Agent', 'KillShell', 'KillBash', 'BashOutput', 'Monitor', 'PowerShell', 'Skill', 'SlashCommand', 'CronCreate', 'RemoteTrigger']);

class Rechazo extends Error {}

function rechazar(mensaje) {
  throw new Rechazo(mensaje);
}

function dentroDelRepo(ruta) {
  return ruta === REPO || ruta.startsWith(`${REPO}/`);
}

function resolverReal(ruta) {
  let actual = ruta;
  const resto = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync(actual);
      return resto.length ? path.join(real, ...resto.reverse()) : real;
    } catch {
      const padre = path.dirname(actual);
      if (padre === actual) return ruta;
      resto.push(path.basename(actual));
      actual = padre;
    }
  }
  return ruta;
}

function resolver(ruta, cwd) {
  if (typeof ruta !== 'string') return null;
  if (ruta.includes('\0')) rechazar('Ruta inválida.');
  if (ruta.startsWith('~')) rechazar('Solo se puede trabajar dentro de /repo.');
  const base = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : REPO;
  const logica = path.resolve(base, ruta);
  return { logica, real: resolverReal(logica) };
}

function protegida(rel) {
  const partes = rel.split('/').filter(Boolean);
  if (!partes.length) return false;
  if (PROTEGIDOS_RAIZ.has(partes[0])) return true;
  return partes.some((p) => PROTEGIDOS_NOMBRE.has(p));
}

function revisarRuta(ruta, cwd, escribe) {
  const r = resolver(ruta, cwd);
  if (!r) return;
  if (!dentroDelRepo(r.logica) || !dentroDelRepo(r.real)) rechazar(`No se puede usar ${ruta}: solo se puede trabajar dentro de /repo.`);
  for (const destino of [r.logica, r.real]) {
    const rel = path.relative(REPO, destino);
    if (rel.split('/').includes('.git')) rechazar('El historial de git del curso lo maneja la plataforma.');
    if (escribe && protegida(rel)) rechazar(`${rel} es un archivo de la plataforma y no se puede modificar.`);
  }
}

function revisarPatron(patron, cwd) {
  if (typeof patron !== 'string' || !patron) return;
  if (patron.startsWith('~')) rechazar('Solo se puede trabajar dentro de /repo.');
  if (patron.split(/[/\\]/).includes('..') || path.isAbsolute(patron)) {
    const fijo = patron.split('/').filter((p) => !/[*?[\]{}]/.test(p)).join('/');
    revisarRuta(fijo || '/', cwd, false);
    if (patron.split('/').includes('..')) rechazar('Solo se puede trabajar dentro de /repo.');
  }
}

const SEP_ANTES = String.raw`(?:^|[\s;&|()\x60{}!]|\$\()`;
const SEP_DESPUES = String.raw`(?=$|[\s;&|()\x60{}<>])`;

function comando(nombres) {
  return new RegExp(`${SEP_ANTES}\\s*(?:\\\\)?(?:${nombres})${SEP_DESPUES}`);
}

const REGLAS_BASH = [
  [comando('env|printenv|compgen|typeset|declare'), 'No se pueden leer las variables de entorno.'],
  [new RegExp(`${SEP_ANTES}\\s*export(?:\\s+-[a-z]*p|\\s*(?:$|[;&|)]))`), 'No se pueden leer las variables de entorno.'],
  [new RegExp(`${SEP_ANTES}\\s*set\\s*(?:$|[;&|)]|-[a-z]*o\\s*(?:$|[;&|)]))`), 'No se pueden leer las variables de entorno.'],
  [/environ|getenv|\bENV\b|process\s*(?:\.|\[\s*['"\x60])\s*env|\)\s*\.\s*env\b|Deno\s*\.\s*env|Bun\s*\.\s*env/, 'No se pueden leer las variables de entorno.'],
  [/ANTHROPIC|CLAUDE_|CAMPUSIA_|AUTH_TOKEN|OAUTH|API_KEY|SESSION_SECRET|\$\{?!/, 'No se pueden leer tokens ni secretos.'],
  [/\$\{?[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASS|token|key|secret|pass)/, 'No se pueden leer tokens ni secretos.'],
  [/\/proc\b|\/sys\b/, 'No se puede leer información del sistema.'],
  [comando('ps|pgrep|top|htop|strace|gdb|ltrace'), 'No se pueden inspeccionar los procesos.'],
  [comando('kill|pkill|killall'), 'El servidor de desarrollo se recarga solo; no hace falta detenerlo.'],
  [comando('git'), 'El historial de git del curso lo maneja la plataforma.'],
  [/(?:^|[\s/'"=:<>])\.git(?=$|[\s/'";|&)<>])/, 'El historial de git del curso lo maneja la plataforma.'],
  [/(?:HTTPS?|ALL|NO|FTP)_PROXY|(?:https?|all|no|ftp)_proxy|noproxy|no-proxy|--proxy|proxy\s*=/i, 'No se puede cambiar el acceso a la red.'],
  [comando('nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp|rsync|nmap|dig|nslookup|host'), 'El espacio de trabajo no tiene acceso a la red salvo npm.'],
  [comando('sudo|su|doas|chroot|unshare|nsenter|mount|umount|docker|podman'), 'Ese comando no está permitido en el espacio de trabajo.'],
  [/(?:^|[\s'"=/<>])(?:Containerfile|\.containerignore|\.dockerignore|\.gitignore|CLAUDE\.md|\.claude|vendor)(?=$|[\s'"/;|&)<>])/, 'Los archivos de la plataforma (vendor/, Containerfile, .gitignore, CLAUDE.md, .claude, ...) no se pueden modificar.'],
  [/(?:pnpm|npm|yarn|npx)\s+(?:run\s+)?(?:dev|start|preview)\b|\bvite\s+(?:dev|serve|preview)?\s*(?:$|[;&|])/, 'La versión de prueba ya corre sola con pnpm dev y se recarga con los cambios.'],
];

function revisarCd(texto) {
  const re = new RegExp(`${SEP_ANTES}\\s*(?:cd|pushd|popd)(?:\\s+([^\\s;&|)]+))?\\s*(?=$|[;&|)])`, 'g');
  let m;
  while ((m = re.exec(texto))) {
    const destino = m[1];
    if (!destino || destino === '-' || destino.startsWith('~') || destino.includes('$')) rechazar('No se puede salir de /repo.');
  }
}

function revisarRutasBash(texto, cwd) {
  if (/(?<![\w.:/~=-])~[\w-]*(?=$|[/\s'"\x60;|&()<>])/.test(texto)) rechazar('Solo se puede trabajar dentro de /repo.');
  if (/\$\{?(?:HOME|PWD|OLDPWD|TMPDIR|XDG_[A-Z_]+)\b/.test(texto)) rechazar('Solo se puede trabajar dentro de /repo.');
  for (const m of texto.matchAll(/(?<![\w.:/@+-])\/[^\s'"\x60;|&()<>,]*/g)) {
    const ruta = m[0];
    const normal = path.posix.normalize(ruta);
    if (DISPOSITIVOS.has(normal)) continue;
    const primera = `/${normal.split('/').filter(Boolean)[0] ?? ''}`;
    if (primera !== REPO && primera !== '/' && !fs.existsSync(primera)) continue;
    const r = resolver(normal, cwd);
    if (!dentroDelRepo(r.logica) || !dentroDelRepo(r.real)) rechazar(`No se puede usar ${ruta}: solo se puede trabajar dentro de /repo.`);
  }
  for (const m of texto.matchAll(/[^\s'"\x60;|&()<>=]*\.\.[^\s'"\x60;|&()<>]*/g)) {
    const token = m[0];
    if (!token.split('/').includes('..')) continue;
    const r = resolver(token, cwd);
    if (!dentroDelRepo(r.logica) || !dentroDelRepo(r.real)) rechazar('No se puede salir de /repo.');
  }
}

function revisarBash(entrada, cwd) {
  const texto = String(entrada?.command ?? '');
  if (!texto.trim()) return;
  if (texto.length > 100000) rechazar('El comando es demasiado largo.');
  if (typeof cwd === 'string' && !dentroDelRepo(resolverReal(cwd))) rechazar('Solo se puede trabajar dentro de /repo.');
  for (const [re, mensaje] of REGLAS_BASH) {
    if (re.test(texto)) rechazar(mensaje);
  }
  revisarCd(texto);
  revisarRutasBash(texto, cwd);
}

function revisar(evento) {
  const nombre = String(evento?.tool_name ?? '');
  const entrada = evento?.tool_input ?? {};
  const cwd = evento?.cwd;
  if (HERRAMIENTAS_PROHIBIDAS.has(nombre) || nombre.startsWith('mcp__')) rechazar(`La herramienta ${nombre} no está disponible en el espacio de trabajo.`);
  if (nombre === 'Bash') return revisarBash(entrada, cwd);
  const regla = HERRAMIENTAS_DE_ARCHIVO[nombre];
  if (!regla) return;
  for (const campo of regla.campos) {
    if (entrada[campo] !== undefined && entrada[campo] !== null && entrada[campo] !== '') revisarRuta(entrada[campo], cwd, regla.escribe);
  }
  for (const campo of regla.patrones ?? []) revisarPatron(entrada[campo], cwd);
  if (typeof cwd === 'string' && !dentroDelRepo(resolverReal(cwd))) rechazar('Solo se puede trabajar dentro de /repo.');
}

function leerEntrada() {
  const partes = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      if (e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    partes.push(Buffer.from(buffer.subarray(0, n)));
  }
  return Buffer.concat(partes).toString('utf8');
}

try {
  revisar(JSON.parse(leerEntrada()));
  process.exit(0);
} catch (e) {
  process.stderr.write(e instanceof Rechazo ? `${e.message}\n` : 'No se pudo verificar la herramienta; se rechaza por seguridad.\n');
  process.exit(2);
}
