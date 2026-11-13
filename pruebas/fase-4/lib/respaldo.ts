import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import { Nucleo, entornoBase } from '../../comun/nucleo.ts';
import { puertoLibre, turnstileFalso } from '../../comun/servicios-falsos.ts';

export const RESPALDAR = path.join(RAIZ_REPO, 'despliegue', 'respaldo', 'respaldar.sh');
export const RESTAURAR = path.join(RAIZ_REPO, 'despliegue', 'respaldo', 'restaurar.sh');

export interface OpcionesRaiz {
  semilla?: string;
  owner?: string;
  entorno?: Record<string, string>;
}

export function raizNueva(): string {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-srv-'));
  for (const d of ['datos', 'cursos', 'archivos', 'config']) fs.mkdirSync(path.join(raiz, d), { mode: 0o700 });
  return raiz;
}

export async function levantarNucleoEnRaiz(raiz: string, op: OpcionesRaiz = {}): Promise<Nucleo> {
  const datos = path.join(raiz, 'datos');
  fs.mkdirSync(datos, { recursive: true });
  const puerto = await puertoLibre();
  const turnstile = await turnstileFalso();
  const entorno = entornoBase(datos, puerto, turnstile.url);
  entorno.LIMITE_CODIGOS_EMAIL = '1000';
  entorno.RAIZ_ARCHIVOS = path.join(raiz, 'archivos');
  entorno.RAIZ_CURSOS = path.join(raiz, 'cursos');
  entorno.DIR_RESPALDOS = path.join(raiz, 'respaldos');
  Object.assign(entorno, op.entorno ?? {});
  const nucleo = new Nucleo(datos, puerto, entorno, turnstile, null, false);
  const migrar = nucleo.ejecutar(['migrar']);
  if (migrar.status !== 0) throw new Error(`migrar falló: ${migrar.stderr}${migrar.stdout}`);
  if (op.semilla) {
    const r = nucleo.ejecutar(['sembrar', op.semilla]);
    if (r.status !== 0) throw new Error(`sembrar falló: ${r.stderr}${r.stdout}`);
  }
  if (op.owner) {
    const r = nucleo.ejecutar(['crear-owner', op.owner]);
    if (r.status !== 0) throw new Error(`crear-owner falló: ${r.stderr}${r.stdout}`);
  }
  await nucleo.iniciar();
  return nucleo;
}

export interface Resultado {
  status: number | null;
  stdout: string;
  stderr: string;
}

function entornoScripts(raiz: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const usuario = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  const grupo = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();
  return {
    ...process.env,
    CAMPUSIA_RAIZ: raiz,
    CAMPUSIA_USUARIO: usuario,
    CAMPUSIA_GRUPO: grupo,
    RESTAURAR_DETENER: 'no',
    ...extra,
  };
}

export function respaldar(raiz: string, extra: Record<string, string> = {}): Resultado {
  const r = spawnSync('bash', [RESPALDAR], { env: entornoScripts(raiz, extra), encoding: 'utf8', timeout: 300_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function restaurarEn(raiz: string, destino: string, respaldo: string): Resultado {
  const r = spawnSync('bash', [RESTAURAR, '--destino', destino, respaldo], { env: entornoScripts(raiz), encoding: 'utf8', timeout: 300_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function respaldosEn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d{8}-\d{6}$/.test(n))
    .sort();
}

export function listarTar(tar: string): string[] {
  const r = spawnSync('tar', ['-tzf', tar], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`tar -tzf falló: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''));
}

export function git(dir: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@campusia.prueba', '-c', 'init.defaultBranch=main', '-C', dir, ...args], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falló: ${r.stderr}`);
  return r.stdout.trim();
}
