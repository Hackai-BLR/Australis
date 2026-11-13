import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ResultadoDocker {
  estado: number | null;
  salida: string;
  error: string;
}

export function docker(args: string[], permitirFallo = false, timeout = 120_000): ResultadoDocker {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout });
  const res = { estado: r.status, salida: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim() };
  if (r.status !== 0 && !permitirFallo) throw new Error(`docker ${args.join(' ')} falló (${r.status}): ${res.error}`);
  return res;
}

export function dockerDisponible(): boolean {
  return docker(['info', '--format', '{{.ServerVersion}}'], true, 30_000).estado === 0;
}

export function nombreContenedor(prefijo: string, id: string) {
  return `${prefijo}-curso-${id}`;
}

export function inspeccionar(nombre: string): any | null {
  const r = docker(['inspect', nombre], true);
  if (r.estado !== 0) return null;
  const arr = JSON.parse(r.salida);
  return arr[0] ?? null;
}

export function inspeccionarRed(nombre: string): any | null {
  const r = docker(['network', 'inspect', nombre], true);
  if (r.estado !== 0) return null;
  return JSON.parse(r.salida)[0] ?? null;
}

export function corriendo(nombre: string): boolean {
  const i = inspeccionar(nombre);
  return !!i?.State?.Running;
}

export function entornoDe(nombre: string): Record<string, string> {
  const i = inspeccionar(nombre);
  const env: Record<string, string> = {};
  for (const e of (i?.Config?.Env ?? []) as string[]) {
    const k = e.indexOf('=');
    env[e.slice(0, k)] = e.slice(k + 1);
  }
  return env;
}

export function ipDe(nombre: string): string | null {
  const i = inspeccionar(nombre);
  const redes = i?.NetworkSettings?.Networks ?? {};
  for (const r of Object.values(redes) as any[]) if (r?.IPAddress) return r.IPAddress;
  return null;
}

export function ejecutarEn(nombre: string, comando: string[], usuario?: string): ResultadoDocker {
  const args = ['exec'];
  if (usuario) args.push('-u', usuario);
  args.push(nombre, ...comando);
  return docker(args, true, 60_000);
}

export function limpiarPrefijo(prefijo: string) {
  const filtro = `label=campusia.prefijo=${prefijo}`;
  const cont = new Set<string>();
  for (const f of [['--filter', filtro], ['--filter', `name=^${prefijo}-`]]) {
    const r = docker(['ps', '-aq', ...f], true);
    for (const id of r.salida.split('\n').filter(Boolean)) cont.add(id);
  }
  if (cont.size) docker(['rm', '-f', ...cont], true);
  const redes = new Set<string>();
  for (const f of [['--filter', filtro], ['--filter', `name=^${prefijo}-`]]) {
    const r = docker(['network', 'ls', '-q', ...f], true);
    for (const id of r.salida.split('\n').filter(Boolean)) redes.add(id);
  }
  if (redes.size) docker(['network', 'rm', ...redes], true);
}

export const PATRON_PREFIJO_PRUEBAS = /^cia[0-9a-f]{8}-/;

function archivoPrefijos(): string | null {
  const corrida = process.env.CAMPUSIA_CORRIDA;
  return corrida ? path.join(corrida, 'prefijos') : null;
}

export function registrarPrefijo(prefijo: string) {
  const archivo = archivoPrefijos();
  if (!archivo) return;
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.appendFileSync(archivo, `${prefijo}\n`);
}

function prefijosDeLaCorrida(): Set<string> {
  const archivo = archivoPrefijos();
  if (!archivo || !fs.existsSync(archivo)) return new Set();
  return new Set(fs.readFileSync(archivo, 'utf8').split('\n').filter((p) => /^cia[0-9a-f]{8}$/.test(p)));
}

export function limpiarImagenesDePruebas() {
  const propios = prefijosDeLaCorrida();
  if (!propios.size) return;
  const r = docker(['images', '--format', '{{.Repository}}:{{.Tag}}'], true);
  const imagenes = r.salida
    .split('\n')
    .filter((x) => PATRON_PREFIJO_PRUEBAS.test(x) && propios.has(x.slice(0, x.indexOf('-'))));
  if (imagenes.length) docker(['rmi', ...imagenes], true, 300_000);
}
