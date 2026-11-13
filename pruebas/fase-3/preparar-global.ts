import { corrida, imagenEspacio } from './lib/imagen.ts';

export default async function prepararGlobal() {
  corrida();
  if (process.env.CAMPUSIA_ESPACIO_IMAGEN) process.env.CAMPUSIA_ESPACIO_IMAGEN_PROPIA = '1';
  process.env.CAMPUSIA_ESPACIO_IMAGEN = imagenEspacio();
}
