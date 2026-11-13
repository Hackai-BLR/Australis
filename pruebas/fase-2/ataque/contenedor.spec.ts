import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { ejecutarEn, inspeccionar, inspeccionarRed, ipDe } from '../lib/docker.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  apiDeCurso,
  contenedorDe,
  cursoListo,
  getCurso,
  idAleatorio,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const test = crearTestCursos({ espia: true });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let a = '';
let b = '';

async function desdeAdentro(nucleo: any, ruta: string) {
  const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
  const r = await getCurso(alumno, a, ruta);
  expect(r.status, r.texto).toBe(200);
  return r.json;
}

test.describe('aislamiento del contenedor', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    a = idAleatorio('aisa');
    b = idAleatorio('aisb');
    await cursoListo(profe, { id: a });
    await cursoListo(profe, { id: b });
    await inscribirOk(profe, a, [ALUMNO_AUSTRAL]);
    await inscribirOk(profe, b, [ALUMNO_AUSTRAL]);
  });

  test('el proceso del curso no es root, no tiene capacidades y no puede escalar', async ({ nucleo }) => {
    const nombre = contenedorDe(nucleo, a);
    const id = ejecutarEn(nombre, ['id', '-u']);
    expect(id.estado).toBe(0);
    expect(id.salida).not.toBe('0');
    const estado = ejecutarEn(nombre, ['cat', '/proc/1/status']);
    const capEff = /CapEff:\s*([0-9a-f]+)/.exec(estado.salida)?.[1];
    const capBnd = /CapBnd:\s*([0-9a-f]+)/.exec(estado.salida)?.[1];
    expect(BigInt(`0x${capEff}`)).toBe(0n);
    expect(BigInt(`0x${capBnd}`)).toBe(0n);
    expect(/NoNewPrivs:\s*1/.test(estado.salida)).toBe(true);
    const info = inspeccionar(nombre);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.NetworkMode).not.toBe('host');
    expect(info.HostConfig.PidMode ?? '').not.toBe('host');
    expect(info.HostConfig.IpcMode ?? '').not.toBe('host');
    expect(info.HostConfig.UsernsMode ?? '').not.toBe('host');
    expect(info.HostConfig.Devices ?? []).toEqual([]);
    expect((info.HostConfig.Binds ?? []).concat((info.Mounts ?? []).map((m: any) => m.Source)).join(' ')).not.toMatch(/docker\.sock|podman\.sock|\/var\/run|\/run\/user/);
  });

  test('solo /datos y /tmp son escribibles', async ({ nucleo }) => {
    const nombre = contenedorDe(nucleo, a);
    for (const ruta of ['/app/x', '/x', '/etc/x', '/usr/local/bin/x']) {
      const r = ejecutarEn(nombre, ['sh', '-c', `echo x > ${ruta}`]);
      expect(r.estado, ruta).not.toBe(0);
    }
    expect(ejecutarEn(nombre, ['sh', '-c', 'echo x > /datos/prueba-escritura && rm /datos/prueba-escritura']).estado).toBe(0);
    expect(ejecutarEn(nombre, ['sh', '-c', 'echo x > /tmp/x']).estado).toBe(0);
  });

  test('los datos de un curso no se ven desde otro', async ({ nucleo }) => {
    const nombre = contenedorDe(nucleo, a);
    const r = ejecutarEn(nombre, ['sh', '-c', 'ls -a /datos; ls / ; cat /proc/mounts']);
    expect(r.salida).not.toContain(b);
    expect(r.salida).not.toContain(nucleo.raizCursos);
    expect(r.salida).not.toContain('campusia.db');
  });

  test('el curso no sale a internet', async ({ nucleo }) => {
    for (const url of ['http://1.1.1.1/', 'https://example.com/', 'http://8.8.8.8:53/', 'https://registry.npmjs.org/']) {
      const r = await desdeAdentro(nucleo, `/espia/red?url=${encodeURIComponent(url)}`);
      expect(r.ok, url).toBe(false);
    }
    for (const [host, puerto] of [['1.1.1.1', 443], ['8.8.8.8', 53]] as Array<[string, number]>) {
      const r = await desdeAdentro(nucleo, `/espia/tcp?host=${host}&puerto=${puerto}`);
      expect(r.ok, `${host}:${puerto}`).toBe(false);
    }
    const red = inspeccionarRed(`${nucleo.prefijo}-cursos`);
    expect(red.Internal).toBe(true);
  });

  test('el curso no llega a otros cursos', async ({ nucleo }) => {
    const ipB = ipDe(contenedorDe(nucleo, b));
    expect(ipB).toBeTruthy();
    const r = await desdeAdentro(nucleo, `/espia/red?url=${encodeURIComponent(`http://${ipB}:3000/salud`)}`);
    expect(r.ok).toBe(false);
    const n = await desdeAdentro(nucleo, `/espia/red?url=${encodeURIComponent(`http://${contenedorDe(nucleo, b)}:3000/salud`)}`);
    expect(n.ok).toBe(false);
  });

  test('desde el curso no se llega a la API ni a la interfaz de la plataforma', async ({ nucleo }) => {
    const base = apiDeCurso(nucleo, a).replace(/\/$/, '');
    const u = new URL(base);
    for (const ruta of ['/api/yo', '/api/admin/personas', '/api/config', '/', '/api/cursos']) {
      const r = await desdeAdentro(nucleo, `/espia/red?url=${encodeURIComponent(base + ruta)}`);
      if (r.ok) {
        expect([401, 404], ruta).toContain(r.estado);
        expect(r.cuerpo).not.toContain('id="raiz"');
      }
    }
    const principal = await desdeAdentro(nucleo, `/espia/tcp?host=${u.hostname}&puerto=${nucleo.puerto}`);
    expect(principal.ok).toBe(false);
    const propia = await desdeAdentro(nucleo, `/espia/red?url=${encodeURIComponent(base + '/api/curso/yo')}`);
    expect(propia.ok).toBe(true);
    expect(propia.estado).toBe(401);
  });

  test('un servidor del equipo que escucha solo en 127.0.0.1 no es alcanzable', async ({ nucleo }) => {
    const servidor = http.createServer((_q, r) => r.end('secreto'));
    await new Promise<void>((res) => servidor.listen(0, '127.0.0.1', () => res()));
    const puerto = (servidor.address() as AddressInfo).port;
    try {
      const u = new URL(apiDeCurso(nucleo, a));
      for (const host of [u.hostname, '127.0.0.1', 'host.docker.internal', '172.17.0.1']) {
        const r = await desdeAdentro(nucleo, `/espia/tcp?host=${host}&puerto=${puerto}`);
        expect(r.ok, host).toBe(false);
      }
    } finally {
      servidor.close();
    }
  });

  test('el contenedor no tiene secretos de la plataforma', async ({ nucleo }) => {
    const env = await desdeAdentro(nucleo, '/espia/entorno');
    expect(Object.keys(env.variables).sort()).toEqual(['CAMPUSIA_API', 'CAMPUSIA_CLAVE_PUBLICA', 'CAMPUSIA_CURSO', 'CAMPUSIA_DATOS', 'CAMPUSIA_TOKEN_CURSO', 'PORT']);
    for (const k of ['SESSION_SECRET', 'IDENTIDAD_CLAVE_PRIVADA', 'DATABASE_URL', 'DOCKER_HOST', 'TURNSTILE_SECRET', 'BREVO_API_KEY', 'XDG_RUNTIME_DIR']) {
      expect(env.claves, k).not.toContain(k);
    }
    const privada = nucleo.consultar("SELECT valor FROM configuracion WHERE clave = 'identidad_clave_privada'")[0]?.valor as string;
    expect(privada).toBeTruthy();
    const info = JSON.stringify(inspeccionar(contenedorDe(nucleo, a)));
    expect(info).not.toContain(privada);
    expect(info).not.toContain(nucleo.entorno.SESSION_SECRET);
    const archivos = ejecutarEn(contenedorDe(nucleo, a), ['sh', '-c', 'grep -rl -- "$0" /app /datos /tmp 2>/dev/null || true', privada]);
    expect(archivos.salida).toBe('');
    const repo = path.join(nucleo.raizCursos, a);
    const todo = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todo(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));
    for (const f of todo(repo)) {
      const contenido = fs.readFileSync(f);
      expect(contenido.includes(Buffer.from(privada)), f).toBe(false);
      expect(contenido.includes(Buffer.from(nucleo.entorno.SESSION_SECRET)), f).toBe(false);
    }
  });

  test('la imagen del curso se construye sin la carpeta de datos ni el historial de git', async ({ nucleo }) => {
    const r = ejecutarEn(contenedorDe(nucleo, a), ['sh', '-c', 'ls -a /app; test -e /app/.git && echo HAYGIT; test -e /app/datos && echo HAYDATOS; true']);
    expect(r.salida).not.toContain('HAYGIT');
    expect(r.salida).not.toContain('HAYDATOS');
  });
});
