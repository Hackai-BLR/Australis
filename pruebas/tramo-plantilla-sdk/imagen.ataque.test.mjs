import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nuevoParDeClaves } from './lib/identidad.mjs';
import { levantarPlataforma } from './lib/plataforma-falsa.mjs';
import { IMAGEN, docker, levantarCurso, bajarCurso, esperarSalud, crearVolumen, borrarVolumen, apiDesdeContenedor } from './lib/docker.mjs';

let par, plataforma, volumen, curso, config;

before(async () => {
  config = JSON.parse(docker(['image', 'inspect', IMAGEN]).salida)[0];
  par = nuevoParDeClaves();
  plataforma = await levantarPlataforma();
  volumen = crearVolumen();
  curso = levantarCurso({ clavePublica: par.publica, api: apiDesdeContenedor(plataforma.puerto), volumen, endurecido: false });
  await esperarSalud(curso);
});

after(async () => {
  bajarCurso(curso);
  borrarVolumen(volumen);
  await plataforma?.cerrar();
});

function enContenedor(codigo) {
  return docker(['exec', curso.nombre, 'node', '-e', codigo], { permitirFallo: true });
}

test('la imagen declara un usuario sin privilegios', () => {
  const usuario = config.Config.User;
  assert.ok(usuario, 'la imagen no declara USER');
  assert.ok(!['root', '0', '0:0', 'root:root'].includes(usuario), `USER es ${usuario}`);
});

test('el proceso del curso no corre como root', () => {
  const r = enContenedor('process.stdout.write(String(process.getuid()) + " " + String(process.getgid()))');
  assert.equal(r.estado, 0, r.error);
  const [uid, gid] = r.salida.split(' ').map(Number);
  assert.notEqual(uid, 0);
  assert.notEqual(gid, 0);
  const pid1 = docker(['top', curso.nombre, '-o', 'pid,user']).salida.split('\n').slice(1).map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+/)[1]);
  assert.ok(pid1.length > 0);
  assert.ok(!pid1.includes('root'), `procesos como root: ${pid1.join(',')}`);
});

test('el usuario del curso no puede modificar el código de la aplicación', () => {
  assert.equal(config.Config.WorkingDir, '/app');
  const r = enContenedor(`
    const fs = require('fs');
    const fallos = [];
    for (const f of ['/app/package.json', '/app/escrito-por-el-curso']) {
      try { fs.writeFileSync(f, 'x'); fallos.push(f); } catch {}
    }
    process.stdout.write(JSON.stringify(fallos));
  `);
  assert.equal(r.estado, 0, r.error);
  assert.deepEqual(JSON.parse(r.salida), []);
});

test('el usuario del curso puede escribir en /datos y la base vive ahí', () => {
  const r = enContenedor(`
    const fs = require('fs');
    fs.writeFileSync('/datos/.prueba', 'x');
    process.stdout.write(JSON.stringify(fs.readdirSync('/datos')));
  `);
  assert.equal(r.estado, 0, r.error);
  assert.ok(JSON.parse(r.salida).includes('curso.sqlite'), `contenido de /datos: ${r.salida}`);
});

test('la imagen no trae herramientas de compilación ni dependencias de desarrollo', () => {
  const r = enContenedor(`
    const fs = require('fs');
    const path = require('path');
    const encontrados = [];
    const dirs = (process.env.PATH || '').split(':').concat(['/usr/bin', '/usr/local/bin', '/bin']);
    for (const b of ['gcc', 'g++', 'cc', 'c++', 'make', 'python3', 'python', 'clang']) {
      for (const d of dirs) if (fs.existsSync(path.join(d, b))) encontrados.push(path.join(d, b));
    }
    for (const m of ['typescript', 'vite', '@vitejs/plugin-react', 'tsx', 'node-gyp']) {
      if (fs.existsSync(path.join('/app/node_modules', m))) encontrados.push('node_modules/' + m);
    }
    process.stdout.write(JSON.stringify([...new Set(encontrados)]));
  `);
  assert.equal(r.estado, 0, r.error);
  assert.deepEqual(JSON.parse(r.salida), []);
});

test('la imagen es chica', () => {
  const mb = config.Size / 1024 / 1024;
  assert.ok(mb < 350, `la imagen pesa ${mb.toFixed(0)} MB`);
});

test('la imagen no trae secretos ni configuración de la plataforma horneados', () => {
  const env = (config.Config.Env || []).join('\n');
  for (const v of ['CAMPUSIA_TOKEN_CURSO', 'CAMPUSIA_CLAVE_PUBLICA', 'CAMPUSIA_API', 'CAMPUSIA_CURSO']) {
    assert.ok(!env.includes(`${v}=`), `la imagen define ${v}`);
  }
});

test('la imagen declara un HEALTHCHECK en /salud y el contenedor queda sano', async () => {
  const hc = config.Config.Healthcheck;
  assert.ok(hc && hc.Test && hc.Test.length > 0, 'falta HEALTHCHECK');
  assert.match(hc.Test.join(' '), /\/salud/);
  const limite = Date.now() + 90000;
  let estado;
  while (Date.now() < limite) {
    estado = docker(['inspect', '-f', '{{.State.Health.Status}}', curso.nombre]).salida;
    if (estado === 'healthy') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(estado, 'healthy');
});

test('la imagen trae una versión fija del SDK igual a la del paquete', () => {
  const sdk = JSON.parse(readFileSync(new URL('../../sdk/package.json', import.meta.url), 'utf8'));
  const plantilla = JSON.parse(readFileSync(new URL('../../plantilla-curso/package.json', import.meta.url), 'utf8'));
  assert.equal(plantilla.dependencies['@campusia/sdk'], `file:vendor/campusia-sdk-${sdk.version}.tgz`);
  const r = enContenedor(`process.stdout.write(require('fs').readFileSync('/app/node_modules/@campusia/sdk/package.json','utf8'))`);
  assert.equal(r.estado, 0, r.error);
  assert.equal(JSON.parse(r.salida).version, sdk.version);
});

test('el curso escucha en el puerto indicado por PORT', async () => {
  const otro = levantarCurso({ clavePublica: par.publica, api: apiDesdeContenedor(plataforma.puerto), extraEnv: { PORT: '3000' } });
  try {
    await esperarSalud(otro);
  } finally {
    bajarCurso(otro);
  }
  const nombre = `campusia-curso-prueba-puerto-${Date.now()}`;
  docker(['run', '-d', '--name', nombre, '-p', '127.0.0.1::4100', '-e', 'PORT=4100', '-e', 'CAMPUSIA_CURSO=redes', '-e', `CAMPUSIA_CLAVE_PUBLICA=${par.publica}`, '-e', `CAMPUSIA_API=${apiDesdeContenedor(plataforma.puerto)}`, '-e', 'CAMPUSIA_TOKEN_CURSO=token-prueba-redes', '-e', 'CAMPUSIA_DATOS=/tmp/datos', '--add-host', 'host.docker.internal:host-gateway', IMAGEN]);
  try {
    const puerto = docker(['port', nombre, '4100/tcp']).salida.split('\n')[0].split(':').pop();
    await esperarSalud({ nombre, base: `http://127.0.0.1:${puerto}` });
  } finally {
    docker(['rm', '-f', nombre], { permitirFallo: true });
  }
});
