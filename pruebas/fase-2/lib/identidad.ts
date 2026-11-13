import crypto from 'node:crypto';

export function b64url(buf: Buffer | Uint8Array) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function desdeB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const PREFIJO_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PREFIJO_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function clavePublicaDesdeB64(publica: string) {
  return crypto.createPublicKey({ key: Buffer.concat([PREFIJO_SPKI, desdeB64url(publica)]), format: 'der', type: 'spki' });
}

export function nuevaSemilla(): { semilla: string; publica: string; privada: crypto.KeyObject } {
  const semilla = crypto.randomBytes(32);
  const privada = crypto.createPrivateKey({ key: Buffer.concat([PREFIJO_PKCS8, semilla]), format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(privada).export({ format: 'jwk' }) as any;
  return { semilla: b64url(semilla), publica: jwk.x, privada };
}

export interface CargaIdentidad {
  v: number;
  curso: string;
  usuario: string;
  email: string;
  nombre: string;
  rol: string;
  emitido: number;
  vence: number;
}

export function leerIdentidad(encabezado: string): CargaIdentidad {
  const [c] = encabezado.split('.');
  return JSON.parse(desdeB64url(c ?? '').toString('utf8'));
}

export function firmaValida(encabezado: string, publica: string): boolean {
  const partes = encabezado.split('.');
  if (partes.length !== 2) return false;
  const [c, f] = partes as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(c) || !/^[A-Za-z0-9_-]+$/.test(f)) return false;
  try {
    return crypto.verify(null, Buffer.from(c, 'ascii'), clavePublicaDesdeB64(publica), desdeB64url(f));
  } catch {
    return false;
  }
}

export function firmar(carga: object, privada: crypto.KeyObject): string {
  const c = b64url(Buffer.from(JSON.stringify(carga), 'utf8'));
  return `${c}.${b64url(crypto.sign(null, Buffer.from(c, 'ascii'), privada))}`;
}
