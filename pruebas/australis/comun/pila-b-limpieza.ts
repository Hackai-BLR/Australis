import { bajarPilaB } from './pila-b.ts';
import { reutilizar } from './pila-b-global.ts';

export default async function limpiar() {
  if (process.env.AUSTRALIS_B_MANTENER === '1' || reutilizar()) return;
  bajarPilaB();
}
