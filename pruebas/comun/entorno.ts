import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BINARIO = path.join(RAIZ_REPO, 'nucleo', 'target', 'debug', 'campusia-nucleo');
export const INTERFAZ_DIST = path.join(RAIZ_REPO, 'interfaz', 'dist');
export const DOMINIO = 'campusia.prueba';
export const COOKIE_SESION = 'campusia_sesion';
