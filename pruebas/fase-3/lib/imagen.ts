import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import { docker } from '../../fase-2/lib/docker.ts';

export const CONSTRUIR_ESPACIO = path.join(RAIZ_REPO, 'despliegue', 'construir-espacio.sh');

export function corrida(): string {
  if (!process.env.CAMPUSIA_CORRIDA) process.env.CAMPUSIA_CORRIDA = crypto.randomBytes(4).toString('hex');
  const id = path
    .basename(process.env.CAMPUSIA_CORRIDA)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '');
  return id || crypto.createHash('sha256').update(process.env.CAMPUSIA_CORRIDA).digest('hex').slice(0, 12);
}

export function imagenEspacio(): string {
  return process.env.CAMPUSIA_ESPACIO_IMAGEN ?? `cia3espacio:${corrida()}`;
}

function dirCandado() {
  return path.join(os.tmpdir(), `campusia-espacio-${corrida()}`);
}

function construir(imagen: string): Promise<{ ok: boolean; salida: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(CONSTRUIR_ESPACIO)) {
      resolve({ ok: false, salida: `No existe ${CONSTRUIR_ESPACIO}: la imagen del espacio de trabajo no existe todavía` });
      return;
    }
    const hijo = spawn('bash', [CONSTRUIR_ESPACIO, '--etiqueta', imagen], { cwd: RAIZ_REPO, env: process.env });
    let salida = '';
    hijo.stdout.on('data', (d) => (salida += d));
    hijo.stderr.on('data', (d) => (salida += d));
    const t = setTimeout(() => hijo.kill('SIGKILL'), 1_500_000);
    hijo.on('exit', (codigo) => {
      clearTimeout(t);
      const existe = docker(['image', 'inspect', imagen], true).estado === 0;
      resolve({ ok: codigo === 0 && existe, salida: salida.slice(-6000) });
    });
  });
}

export async function asegurarImagenEspacio(): Promise<string> {
  const imagen = imagenEspacio();
  if (docker(['image', 'inspect', imagen], true).estado === 0 && process.env.CAMPUSIA_ESPACIO_IMAGEN) return imagen;
  const dir = dirCandado();
  const listo = path.join(dir, 'listo');
  const fallo = path.join(dir, 'fallo');
  let mio = false;
  try {
    fs.mkdirSync(dir);
    mio = true;
  } catch {
    mio = false;
  }
  if (mio) {
    const r = await construir(imagen);
    fs.writeFileSync(r.ok ? listo : fallo, r.salida);
    if (!r.ok) throw new Error(`No se pudo construir la imagen del espacio ${imagen}:\n${r.salida}`);
    return imagen;
  }
  const limite = Date.now() + 1_600_000;
  while (Date.now() < limite) {
    if (fs.existsSync(listo)) return imagen;
    if (fs.existsSync(fallo)) {
      throw new Error(`No se pudo construir la imagen del espacio ${imagen}:\n${fs.readFileSync(fallo, 'utf8')}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`La imagen del espacio ${imagen} no terminó de construirse a tiempo`);
}

export function limpiarImagenEspacio() {
  const imagen = imagenEspacio();
  if (!process.env.CAMPUSIA_ESPACIO_IMAGEN_PROPIA) docker(['rmi', '-f', imagen], true, 300_000);
  fs.rmSync(dirCandado(), { recursive: true, force: true });
}
