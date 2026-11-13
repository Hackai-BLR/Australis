import fs from 'node:fs';
import { dockerDisponible, limpiarImagenesDePruebas } from './lib/docker.ts';

export default async function limpiezaGlobal() {
  if (dockerDisponible()) limpiarImagenesDePruebas();
  if (process.env.CAMPUSIA_CORRIDA_TEMPORAL === '1' && process.env.CAMPUSIA_CORRIDA) {
    fs.rmSync(process.env.CAMPUSIA_CORRIDA, { recursive: true, force: true });
  }
}
