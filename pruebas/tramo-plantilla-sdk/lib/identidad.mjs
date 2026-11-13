import { generateKeyPairSync, sign } from 'node:crypto';

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function nuevoParDeClaves() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { privada: privateKey, publica: jwk.x };
}

export function ahoraSeg() {
  return Math.floor(Date.now() / 1000);
}

export function cargaBase(extra = {}) {
  const t = ahoraSeg();
  return {
    v: 1,
    curso: 'redes',
    usuario: 'u-alumno-1',
    email: 'ana.gomez@austral.edu.ar',
    nombre: 'Ana Gómez',
    rol: 'alumno',
    emitido: t,
    vence: t + 60,
    ...extra,
  };
}

export function firmarCadena(cadena, privada) {
  return b64url(sign(null, Buffer.from(cadena, 'ascii'), privada));
}

export function firmar(carga, privada) {
  const c = b64url(Buffer.from(JSON.stringify(carga), 'utf8'));
  return `${c}.${firmarCadena(c, privada)}`;
}

export function partes(encabezado) {
  const [c, f] = encabezado.split('.');
  return { c, f };
}

export const PERSONAS = {
  duenio: { usuario: 'u-duenio', email: 'lucia.fernandez@austral.edu.ar', nombre: 'Lucía Fernández', rol: 'dueño' },
  profesor: { usuario: 'u-profe-2', email: 'martin.sosa@austral.edu.ar', nombre: 'Martín Sosa', rol: 'profesor' },
  alumno: { usuario: 'u-alumno-1', email: 'ana.gomez@austral.edu.ar', nombre: 'Ana Gómez', rol: 'alumno' },
};

export function encabezadoDe(persona, privada, extra = {}) {
  return firmar(cargaBase({ ...PERSONAS[persona], ...extra }), privada);
}
