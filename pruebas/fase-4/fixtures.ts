import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearTest } from '../comun/fixtures.ts';
import type { OpcionesNucleo } from '../comun/nucleo.ts';

export const SEMILLA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos.json');

export const OWNER = 'equipo@campusia.prueba';
export const ADMIN_AUSTRAL = 'ana.morales@austral.edu.ar';
export const DUENO_REDES = 'lfernandez@austral.edu.ar';
export const PROFE_REDES = 'dherrera@austral.edu.ar';
export const PROFE_SIN_CURSOS = 'mruiz@austral.edu.ar';
export const ALUMNO_REDES = 'tgarcia@mail.austral.edu.ar';
export const ALUMNA_REDES = 'slopez@mail.austral.edu.ar';
export const SIN_CURSOS = 'psinmarca@austral.edu.ar';
export const ADMIN_DEMO = 'admin@demo.edu.ar';
export const PROFE_DEMO = 'profe@demo.edu.ar';
export const ALUMNO_DEMO = 'alumno@demo.edu.ar';

export const REDES = 'redes';
export const ALGORITMOS = 'algoritmos';
export const ETICA = 'etica';
export const QUIMICA = 'quimica';

export function crearTestDatos(op: OpcionesNucleo = {}) {
  return crearTest({ semilla: SEMILLA, owner: OWNER, ...op });
}

export { expect } from '@playwright/test';

export const MIEMBROS_REDES = {
  dueno: DUENO_REDES,
  profesores: [PROFE_REDES],
  alumnos: [ALUMNO_REDES, ALUMNA_REDES],
};
