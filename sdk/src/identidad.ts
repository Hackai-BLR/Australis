import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export type Rol = 'dueño' | 'profesor' | 'alumno';

export const ROLES: readonly Rol[] = Object.freeze(['dueño', 'profesor', 'alumno'] as Rol[]);

export interface Identidad {
  v: 1;
  curso: string;
  usuario: string;
  email: string;
  nombre: string;
  rol: Rol;
  emitido: number;
  vence: number;
}

export type CodigoErrorIdentidad =
  | 'configuracion'
  | 'ausente'
  | 'formato'
  | 'firma'
  | 'version'
  | 'curso'
  | 'vigencia'
  | 'vencido'
  | 'futuro';

export interface OpcionesVerificacion {
  clavePublica: string;
  curso: string;
  ahora?: number;
}

const MENSAJES: Record<CodigoErrorIdentidad, string> = {
  configuracion: 'La configuración de identidad del curso no es válida',
  ausente: 'Falta el encabezado de identidad',
  formato: 'El encabezado de identidad no tiene un formato válido',
  firma: 'La firma de la identidad no es válida',
  version: 'La versión de la identidad no es compatible',
  curso: 'La identidad corresponde a otro curso',
  vigencia: 'La vigencia de la identidad no es válida',
  vencido: 'La identidad está vencida',
  futuro: 'La identidad fue emitida en el futuro',
};

export class ErrorIdentidad extends Error {
  readonly codigo: CodigoErrorIdentidad;

  constructor(codigo: CodigoErrorIdentidad, mensaje?: string) {
    super(mensaje ?? MENSAJES[codigo]);
    this.name = 'ErrorIdentidad';
    this.codigo = codigo;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const LARGO_MAXIMO_ENCABEZADO = 4096;
export const VIGENCIA_MAXIMA = 120;
export const TOLERANCIA_FUTURO = 30;

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const CAMPOS = ['v', 'curso', 'usuario', 'email', 'nombre', 'rol', 'emitido', 'vence'] as const;
const CLAVES_EN_CACHE = 16;
const cacheClaves = new Map<string, KeyObject>();

function decodificarCanonico(texto: string, largo: number): Buffer | null {
  if (!BASE64URL.test(texto)) return null;
  const bytes = Buffer.from(texto, 'base64url');
  if (bytes.length !== largo) return null;
  if (bytes.toString('base64url') !== texto) return null;
  return bytes;
}

function claveDe(clavePublica: unknown): KeyObject {
  if (typeof clavePublica !== 'string') throw new ErrorIdentidad('configuracion');
  const enCache = cacheClaves.get(clavePublica);
  if (enCache) return enCache;
  if (!decodificarCanonico(clavePublica, 32)) throw new ErrorIdentidad('configuracion');
  let clave: KeyObject;
  try {
    clave = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: clavePublica }, format: 'jwk' });
  } catch {
    throw new ErrorIdentidad('configuracion');
  }
  if (cacheClaves.size >= CLAVES_EN_CACHE) cacheClaves.clear();
  cacheClaves.set(clavePublica, clave);
  return clave;
}

const decodificadorUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function leerCarga(carga: string): Record<string, unknown> {
  const bytes = Buffer.from(carga, 'base64url');
  if (bytes.toString('base64url') !== carga) throw new ErrorIdentidad('formato');
  let datos: unknown;
  try {
    datos = JSON.parse(decodificadorUtf8.decode(bytes));
  } catch {
    throw new ErrorIdentidad('formato');
  }
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) throw new ErrorIdentidad('formato');
  return datos as Record<string, unknown>;
}

function esRol(valor: unknown): valor is Rol {
  return typeof valor === 'string' && (ROLES as readonly string[]).includes(valor);
}

export function verificarIdentidad(
  encabezado: string | null | undefined,
  opciones: OpcionesVerificacion,
): Identidad {
  if (typeof opciones !== 'object' || opciones === null) throw new ErrorIdentidad('configuracion');
  const clave = claveDe(opciones.clavePublica);
  const cursoPropio = opciones.curso;
  if (typeof cursoPropio !== 'string' || cursoPropio.length === 0) throw new ErrorIdentidad('configuracion');
  let ahora: number;
  if (opciones.ahora === undefined) {
    ahora = Math.floor(Date.now() / 1000);
  } else if (typeof opciones.ahora === 'number' && Number.isFinite(opciones.ahora)) {
    ahora = opciones.ahora;
  } else {
    throw new ErrorIdentidad('configuracion');
  }

  if (encabezado === undefined || encabezado === null || encabezado === '') throw new ErrorIdentidad('ausente');
  if (typeof encabezado !== 'string') throw new ErrorIdentidad('formato');
  if (encabezado.length > LARGO_MAXIMO_ENCABEZADO) throw new ErrorIdentidad('formato');
  const partes = encabezado.split('.');
  if (partes.length !== 2) throw new ErrorIdentidad('formato');
  const [carga, firmaTexto] = partes as [string, string];
  if (carga.length === 0 || !BASE64URL.test(carga)) throw new ErrorIdentidad('formato');
  const firma = decodificarCanonico(firmaTexto, 64);
  if (!firma) throw new ErrorIdentidad('formato');

  let valida = false;
  try {
    valida = verify(null, Buffer.from(carga, 'ascii'), clave, firma);
  } catch {
    valida = false;
  }
  if (!valida) throw new ErrorIdentidad('firma');

  const datos = leerCarga(carga);
  for (const campo of CAMPOS) {
    if (!Object.prototype.hasOwnProperty.call(datos, campo)) throw new ErrorIdentidad('formato');
  }
  const { v, curso, usuario, email, nombre, rol, emitido, vence } = datos;
  if (
    typeof curso !== 'string' ||
    typeof usuario !== 'string' ||
    typeof email !== 'string' ||
    typeof nombre !== 'string' ||
    !Number.isSafeInteger(emitido) ||
    !Number.isSafeInteger(vence) ||
    !esRol(rol)
  ) {
    throw new ErrorIdentidad('formato');
  }
  if (typeof v !== 'number') throw new ErrorIdentidad('formato');
  if (v !== 1) throw new ErrorIdentidad('version');
  if (curso !== cursoPropio) throw new ErrorIdentidad('curso');
  const desde = emitido as number;
  const hasta = vence as number;
  if (hasta <= desde || hasta - desde > VIGENCIA_MAXIMA) throw new ErrorIdentidad('vigencia');
  if (ahora >= hasta) throw new ErrorIdentidad('vencido');
  if (desde > ahora + TOLERANCIA_FUTURO) throw new ErrorIdentidad('futuro');

  return Object.freeze({ v: 1, curso, usuario, email, nombre, rol, emitido: desde, vence: hasta });
}
