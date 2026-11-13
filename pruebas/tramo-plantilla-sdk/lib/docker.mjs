import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const IMAGEN = process.env.IMAGEN_CURSO || 'campusia-curso:tramo-prueba';

export function docker(args, { permitirFallo = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !permitirFallo) {
    throw new Error(`docker ${args.join(' ')} falló (${r.status}): ${r.stderr}`);
  }
  return { estado: r.status, salida: (r.stdout || '').trim(), error: (r.stderr || '').trim() };
}

export function sufijo() {
  return randomBytes(4).toString('hex');
}

export function crearVolumen() {
  const nombre = `campusia-prueba-${sufijo()}`;
  docker(['volume', 'create', nombre]);
  return nombre;
}

export function borrarVolumen(nombre) {
  docker(['volume', 'rm', '-f', nombre], { permitirFallo: true });
}

export function levantarCurso({ clavePublica, api, curso = 'redes', token = 'token-prueba-redes', volumen, endurecido = true, extraEnv = {} }) {
  const nombre = `campusia-curso-prueba-${sufijo()}`;
  const args = ['run', '-d', '--name', nombre, '-p', '127.0.0.1::3000', '--add-host', 'host.docker.internal:host-gateway'];
  if (endurecido) {
    args.push('--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '256');
  }
  if (volumen) args.push('-v', `${volumen}:/datos`);
  const env = {
    PORT: '3000',
    CAMPUSIA_CURSO: curso,
    CAMPUSIA_CLAVE_PUBLICA: clavePublica,
    CAMPUSIA_API: api,
    CAMPUSIA_TOKEN_CURSO: token,
    CAMPUSIA_DATOS: '/datos',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGEN);
  docker(args);
  const r = docker(['port', nombre, '3000/tcp'], { permitirFallo: true });
  if (r.estado !== 0 || !r.salida) return { nombre, base: null };
  const puerto = r.salida.split('\n')[0].split(':').pop();
  return { nombre, base: `http://127.0.0.1:${puerto}` };
}

export function bajarCurso(c) {
  if (!c) return;
  docker(['rm', '-f', c.nombre], { permitirFallo: true });
}

export function registros(c) {
  return docker(['logs', c.nombre], { permitirFallo: true });
}

export async function esperarSalud(c, ms = 60000) {
  if (!c.base) {
    const l = registros(c);
    throw new Error(`el contenedor terminó al arrancar\n${l.salida}\n${l.error}`);
  }
  const limite = Date.now() + ms;
  let ultimo;
  while (Date.now() < limite) {
    try {
      const r = await fetch(`${c.base}/salud`);
      if (r.status === 200) return;
      ultimo = `estado ${r.status}`;
    } catch (e) {
      ultimo = String(e.cause || e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const l = registros(c);
  throw new Error(`el curso no respondió /salud a tiempo (${ultimo})\n${l.salida}\n${l.error}`);
}

export function apiDesdeContenedor(puerto) {
  return `http://host.docker.internal:${puerto}`;
}
