import { bajarPila } from './pila.ts';

export default async function limpiar() {
  if (!process.env.AUSTRALIS_URL) bajarPila();
}
