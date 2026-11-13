import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BINARIO, INTERFAZ_DIST, RAIZ_REPO } from './entorno.ts';

function correr(comando: string, args: string[]) {
  execFileSync(comando, args, { cwd: RAIZ_REPO, stdio: 'inherit' });
}

export default async function compilar() {
  if (!process.env.CAMPUSIA_CORRIDA) {
    process.env.CAMPUSIA_CORRIDA = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-corrida-'));
    process.env.CAMPUSIA_CORRIDA_TEMPORAL = '1';
  }
  if (process.env.CAMPUSIA_SIN_COMPILAR !== '1') {
    if (!fs.existsSync(path.join(RAIZ_REPO, 'nucleo', 'Cargo.toml'))) {
      throw new Error('Falta nucleo/Cargo.toml: el núcleo no existe todavía');
    }
    if (!fs.existsSync(path.join(RAIZ_REPO, 'interfaz', 'package.json'))) {
      throw new Error('Falta interfaz/package.json: la interfaz no existe todavía');
    }
    correr('bash', ['-c', '. "$HOME/.cargo/env" && cargo build --manifest-path nucleo/Cargo.toml']);
    correr('pnpm', ['--dir', 'interfaz', 'install']);
    correr('pnpm', ['--dir', 'interfaz', 'run', 'build']);
    if (fs.existsSync(path.join(RAIZ_REPO, 'sdk', 'package.json')) && fs.existsSync(path.join(RAIZ_REPO, 'plantilla-curso', 'package.json'))) {
      correr('pnpm', ['--dir', 'sdk', 'install', '--no-frozen-lockfile']);
      correr('pnpm', ['--dir', 'sdk', 'run', 'build']);
      const vendor = path.join(RAIZ_REPO, 'plantilla-curso', 'vendor');
      fs.mkdirSync(vendor, { recursive: true });
      for (const f of fs.readdirSync(vendor)) if (/^campusia-sdk-.*\.tgz$/.test(f)) fs.rmSync(path.join(vendor, f));
      correr('pnpm', ['--dir', 'sdk', 'pack', '--pack-destination', vendor]);
    }
  }
  if (!fs.existsSync(BINARIO)) throw new Error(`No se encontró el binario ${BINARIO}`);
  if (!fs.existsSync(path.join(INTERFAZ_DIST, 'index.html'))) throw new Error(`No se encontró ${INTERFAZ_DIST}/index.html`);
}
