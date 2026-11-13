import { dockerDisponible } from '../fase-2/lib/docker.ts';
import { limpiarImagenEspacio } from './lib/imagen.ts';

export default async function limpiezaGlobal() {
  if (dockerDisponible()) limpiarImagenEspacio();
}
