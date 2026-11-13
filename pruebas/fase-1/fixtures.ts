import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearTest } from '../comun/fixtures.ts';
import { MODO_CODIGO } from '../comun/nucleo.ts';

export const SEMILLA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos.json');

export const OWNER = 'equipo@campusia.prueba';
export const ADMIN_AUSTRAL = 'ana.morales@austral.edu.ar';
export const PROFE_AUSTRAL = 'lfernandez@austral.edu.ar';
export const PROFE2_AUSTRAL = 'dherrera@austral.edu.ar';
export const ALUMNO_AUSTRAL = 'tgarcia@mail.austral.edu.ar';
export const PENDIENTE_AUSTRAL = 'cpendiente@austral.edu.ar';
export const ADMIN_DEMO = 'admin@demo.edu.ar';
export const PROFE_DEMO = 'profe@demo.edu.ar';
export const ALUMNO_DEMO = 'alumno@demo.edu.ar';
export const UNI_AUSTRAL = 'Universidad Austral';
export const UNI_DEMO = 'Universidad de Prueba';
export const USO_AUSTRAL = 68;

export const test = crearTest({ semilla: SEMILLA, owner: OWNER });

export const testCodigo = crearTest({ semilla: SEMILLA, owner: OWNER, entorno: MODO_CODIGO });

export { expect } from '@playwright/test';
