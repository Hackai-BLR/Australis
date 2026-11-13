import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ESTADO = path.join(os.tmpdir(), 'australis-pruebas-pila.json');
export const CORREO_SECRETARIA = 'secretaria@pruebas.example';
export const CLAVE_SECRETARIA = 'clave-secretaria-1';

export type EstadoPila = { url: string; red: string; contenedores: string[] };

function docker(args: string[], silencioso = false): string {
  return execFileSync('docker', args, {
    cwd: RAIZ_REPO,
    encoding: 'utf8',
    stdio: silencioso ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  }).trim();
}

async function esperarSalud(url: string) {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`La pila no respondió en ${url}/api/health`);
}

export async function levantarPila(): Promise<EstadoPila> {
  const externa = process.env.AUSTRALIS_URL;
  if (externa) {
    await esperarSalud(externa);
    return { url: externa, red: '', contenedores: [] };
  }
  const sufijo = `${process.pid}-${Date.now().toString(36)}`;
  const red = `australis-pruebas-${sufijo}`;
  const backend = `australis-pruebas-backend-${sufijo}`;
  const frontend = `australis-pruebas-frontend-${sufijo}`;
  if (process.env.AUSTRALIS_SIN_COMPILAR !== '1') {
    docker(['build', '-t', 'australis-pruebas-backend', './backend']);
    docker(['build', '-t', 'australis-pruebas-frontend', './frontend']);
  }
  docker(['network', 'create', red], true);
  const estado: EstadoPila = { url: '', red, contenedores: [backend, frontend] };
  fs.writeFileSync(ESTADO, JSON.stringify(estado));
  docker([
    'run', '-d', '--name', backend, '--network', red, '--network-alias', 'backend',
    '-e', `SEED_ADMIN_EMAIL=${CORREO_SECRETARIA}`,
    '-e', `SEED_ADMIN_PASSWORD=${CLAVE_SECRETARIA}`,
    '-e', 'AI_PROVIDER=placeholder',
    '-e', 'ZOOM_PROVIDER=placeholder',
    'australis-pruebas-backend',
  ]);
  docker([
    'run', '-d', '--name', frontend, '--network', red, '-p', '127.0.0.1::80',
    'australis-pruebas-frontend',
  ]);
  const puerto = docker(['port', frontend, '80/tcp']).split('\n')[0].split(':').pop();
  estado.url = `http://127.0.0.1:${puerto}`;
  fs.writeFileSync(ESTADO, JSON.stringify(estado));
  await esperarSalud(estado.url);
  return estado;
}

export function bajarPila() {
  if (!fs.existsSync(ESTADO)) return;
  const estado: EstadoPila = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  for (const c of estado.contenedores) {
    try {
      docker(['rm', '-f', '-v', c], true);
    } catch {}
  }
  if (estado.red) {
    try {
      docker(['network', 'rm', estado.red], true);
    } catch {}
  }
  fs.rmSync(ESTADO, { force: true });
}

export function urlPila(): string {
  if (process.env.AUSTRALIS_URL) return process.env.AUSTRALIS_URL;
  return (JSON.parse(fs.readFileSync(ESTADO, 'utf8')) as EstadoPila).url;
}
