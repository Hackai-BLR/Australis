import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [carpeta, bloqueo] = process.argv.slice(2);
const tarball = fs.readdirSync(carpeta).find((f) => /^campusia-sdk-.*\.tgz$/.test(f));
if (!tarball) throw new Error('No hay un paquete del SDK en ' + carpeta);
const integridad = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(carpeta, tarball))).digest('base64');
const texto = fs.readFileSync(bloqueo, 'utf8');
const patron = /(integrity: )sha512-[A-Za-z0-9+/=]+(, tarball: file:vendor\/campusia-sdk-[0-9.]+\.tgz)/;
if (!patron.test(texto)) throw new Error('El bloqueo de la plantilla no fija el paquete del SDK');
fs.writeFileSync(bloqueo, texto.replace(patron, `$1${integridad}$2`));
console.log(`SDK fijado en ${bloqueo}: ${integridad}`);
