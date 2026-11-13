import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [carpeta, bloqueo] = process.argv.slice(2);
const tarball = fs.readdirSync(carpeta).find((f) => /^campusia-sdk-.*\.tgz$/.test(f));
if (!tarball) throw new Error('No hay un paquete del SDK en ' + carpeta);
const empaquetado = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(carpeta, tarball))).digest('base64');
const actual = fs.readFileSync(bloqueo, 'utf8').match(/integrity: (sha512-[A-Za-z0-9+/=]+), tarball: file:vendor\/campusia-sdk-[0-9.]+\.tgz/);
if (!actual) throw new Error('El bloqueo de la plantilla no fija el paquete del SDK');
const original = actual[1];
const coincidia = original === empaquetado;
fs.writeFileSync(path.join(carpeta, 'bloqueo-sdk.json'), JSON.stringify({ coincidia, original, empaquetado }));
if (!coincidia) {
  console.error(`El bloqueo de la plantilla (${original}) no coincide con el SDK empaquetado (${empaquetado}); regenerar plantilla-curso/pnpm-lock.yaml`);
  process.exit(1);
}
console.log(`El bloqueo de la plantilla coincide con el SDK empaquetado: ${empaquetado}`);
