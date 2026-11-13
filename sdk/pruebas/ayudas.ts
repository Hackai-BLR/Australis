import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface Par {
  privada: KeyObject;
  publica: string;
}

export function b64url(datos: Buffer | string): string {
  return Buffer.from(datos).toString('base64url');
}

export function nuevoPar(): Par {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { privada: privateKey, publica: String(jwk.x) };
}

export function firmarCadena(cadena: string, privada: KeyObject): string {
  return b64url(sign(null, Buffer.from(cadena, 'ascii'), privada));
}

export function firmar(carga: unknown, privada: KeyObject): string {
  const c = b64url(Buffer.from(JSON.stringify(carga), 'utf8'));
  return `${c}.${firmarCadena(c, privada)}`;
}

export const T = 1_800_000_000;

export function carga(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    curso: 'redes',
    usuario: 'u-alumno-1',
    email: 'ana.gomez@austral.edu.ar',
    nombre: 'Ana Gómez',
    rol: 'alumno',
    emitido: T,
    vence: T + 60,
    ...extra,
  };
}
