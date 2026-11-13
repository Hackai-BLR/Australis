import fs from 'node:fs';
import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { contenedorDe, inscribirOk, sesion } from '../../fase-2/lib/cursos.ts';
import { docker, ejecutarEn, inspeccionar, inspeccionarRed, ipDe } from '../../fase-2/lib/docker.ts';
import { firmaValida, leerIdentidad } from '../../fase-2/lib/identidad.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  ESPERA_RECARGA_MS,
  cursoConEspacio,
  enPrueba,
  entornoEspacio,
  esperarRespuesta,
  guion,
  guionEscribir,
  nombreEspacio,
  pedidoOk,
  textoArchivos,
} from '../lib/agente.ts';

const test = crearTestAgente({ espia: true });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let a = '';
let b = '';
let profe: Cliente;

const SONDA = `
const net = require('node:net');
const [host, puerto, linea] = process.argv.slice(1);
const s = net.connect({ host, port: Number(puerto) });
const t = setTimeout(() => { console.log('SIN_RESPUESTA'); s.destroy(); process.exit(0); }, 5000);
s.on('connect', () => { if (linea) s.write(linea.replace(/\\\\r\\\\n/g, '\\r\\n')); else { console.log('CONECTADO'); clearTimeout(t); s.destroy(); process.exit(0); } });
s.on('data', (d) => { console.log('RESPUESTA ' + d.toString().split('\\r\\n')[0]); clearTimeout(t); s.destroy(); process.exit(0); });
s.on('error', (e) => { console.log('ERROR ' + e.code); clearTimeout(t); process.exit(0); });
`;

function sonda(nombre: string, host: string, puerto: number | string, linea = ''): string {
  const r = ejecutarEn(nombre, ['node', '-e', SONDA, host, String(puerto), linea]);
  return r.salida;
}

function connect(nombre: string, proxyHost: string, proxyPuerto: number, destino: string) {
  return sonda(nombre, proxyHost, proxyPuerto, `CONNECT ${destino} HTTP/1.1\\r\\nHost: ${destino}\\r\\n\\r\\n`);
}

test.describe('el espacio de trabajo está aislado', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    const otro = await sesion(nucleo, PROFE2_AUSTRAL);
    a = await cursoConEspacio(profe, { nombre: 'Curso Aislado' });
    b = await cursoConEspacio(otro, { nombre: 'Curso Vecino' });
    await inscribirOk(profe, a, ['tgarcia@mail.austral.edu.ar']);
    guion(nucleo, 'algo', guionEscribir({ 'notas.md': 'notas\n' }));
    await pedidoOk(profe, a, 'Agregá notas [guion:algo]');
  });

  test('sin privilegios, sin capacidades, con límites y solo lectura', async ({ nucleo }) => {
    const nombre = nombreEspacio(nucleo, a);
    const info = inspeccionar(nombre);
    const hc = info.HostConfig;
    expect(hc.Privileged).toBe(false);
    expect(hc.NetworkMode).toBe(`${nucleo.prefijo}-espacios`);
    expect(hc.PidMode ?? '').not.toBe('host');
    expect(hc.IpcMode ?? '').not.toBe('host');
    expect(hc.UsernsMode ?? '').not.toBe('host');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Memory).toBeGreaterThan(0);
    expect(hc.NanoCpus).toBeGreaterThan(0);
    expect(hc.PidsLimit).toBeGreaterThan(0);
    expect(hc.Devices ?? []).toEqual([]);
    expect(Object.keys(hc.PortBindings ?? {})).toEqual([]);
    expect((hc.SecurityOpt ?? []).join(' ')).toContain('no-new-privileges');
    const montajes = JSON.stringify([hc.Binds ?? [], info.Mounts ?? []]);
    expect(montajes).not.toMatch(/docker\.sock|podman\.sock|\/var\/run|\/run\/user/);
    expect(ejecutarEn(nombre, ['id', '-u']).salida).not.toBe('0');
    const estado = ejecutarEn(nombre, ['cat', '/proc/1/status']).salida;
    expect(BigInt(`0x${/CapEff:\s*([0-9a-f]+)/.exec(estado)?.[1]}`)).toBe(0n);
    expect(BigInt(`0x${/CapBnd:\s*([0-9a-f]+)/.exec(estado)?.[1]}`)).toBe(0n);
    expect(/NoNewPrivs:\s*1/.test(estado)).toBe(true);
    for (const ruta of ['/x', '/etc/x', '/usr/local/bin/x', '/usr/local/lib/x', '/etc/claude-code/managed-settings.json']) {
      expect(ejecutarEn(nombre, ['sh', '-c', `echo x >> ${ruta}`]).estado, ruta).not.toBe(0);
    }
    expect(ejecutarEn(nombre, ['sh', '-c', 'echo x > /repo/.escritura && rm /repo/.escritura']).estado).toBe(0);
    expect(ejecutarEn(nombre, ['sh', '-c', 'echo x > /tmp/x']).estado).toBe(0);
    const ajustes = ejecutarEn(nombre, ['cat', '/etc/claude-code/managed-settings.json']);
    expect(ajustes.estado).toBe(0);
    expect(ajustes.salida).toContain('PreToolUse');
    expect(ejecutarEn(nombre, ['stat', '-c', '%u', '/etc/claude-code/managed-settings.json']).salida).toBe('0');
    expect(ejecutarEn(nombre, ['sh', '-c', 'ls -a /var/run/docker.sock /run/docker.sock /run/podman 2>/dev/null']).salida).toBe('');
    const montados = ejecutarEn(nombre, ['cat', '/proc/mounts']).salida;
    expect(montados).not.toContain(nucleo.raizCursos);
    expect(montados).not.toContain('campusia.db');
    expect(ejecutarEn(nombre, ['sh', '-c', `ls ${nucleo.raizCursos} ${nucleo.raizEspacios} 2>&1`]).salida).not.toContain(b);
  });

  test('la red es interna: no hay internet ni otros cursos, y el proxy solo deja npm', async ({ nucleo }) => {
    const nombre = nombreEspacio(nucleo, a);
    const red = inspeccionarRed(`${nucleo.prefijo}-espacios`);
    expect(red.Internal).toBe(true);
    expect(red.Options?.['com.docker.network.bridge.enable_icc']).toBe('false');
    const env = entornoEspacio(nucleo, a);
    const proxy = new URL(env.HTTPS_PROXY ?? env.https_proxy ?? '');
    const host = proxy.hostname;
    const p = Number(proxy.port);

    for (const [destino, puerto] of [
      ['1.1.1.1', 443],
      ['8.8.8.8', 53],
      [ipDe(nombreEspacio(nucleo, b))!, 3000],
      [ipDe(contenedorDe(nucleo, a))!, 3000],
      [ipDe(contenedorDe(nucleo, b))!, 3000],
      [host, nucleo.puerto],
      [host, nucleo.puertoApiCursos],
    ] as Array<[string, number]>) {
      expect(sonda(nombre, destino, puerto), `${destino}:${puerto}`).not.toContain('CONECTADO');
    }
    expect(sonda(nombre, host, nucleo.puertoEspacios)).toContain('CONECTADO');
    expect(sonda(nombre, host, p)).toContain('CONECTADO');

    for (const destino of ['example.com:443', 'github.com:443', '1.1.1.1:443', 'registry.npmjs.org:80', 'registry.npmjs.org.evil.com:443', `${host}:${nucleo.puerto}`, 'localhost:22']) {
      const r = connect(nombre, host, p, destino);
      expect(r, destino).toContain('RESPUESTA');
      expect(r, destino).toMatch(/ 40[35] /);
    }
    const npm = connect(nombre, host, p, 'registry.npmjs.org:443');
    expect(npm).toContain('RESPUESTA');
    expect(npm).not.toMatch(/ 40[35] /);
    const plano = sonda(nombre, host, p, 'GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n');
    expect(plano).toMatch(/RESPUESTA HTTP\/1\.[01] 40[35]/);
  });

  test('los secretos no están en el espacio, en los registros, en los repos ni en la base', async ({ nucleo }) => {
    const nombre = nombreEspacio(nucleo, a);
    const env = entornoEspacio(nucleo, a);
    const cmt = env.ANTHROPIC_AUTH_TOKEN!;
    const cct = env.CAMPUSIA_TOKEN_CURSO!;
    const real = nucleo.tokenReal;
    const nombres = docker(['ps', '-a', '--filter', `label=campusia.prefijo=${nucleo.prefijo}`, '--format', '{{.Names}}'], true).salida.split('\n').filter(Boolean);
    expect(nombres.length).toBeGreaterThanOrEqual(3);
    for (const n of nombres) {
      expect(docker(['inspect', n], true).salida, n).not.toContain(real);
      const logs = docker(['logs', n], true);
      expect(`${logs.salida}${logs.error}`, n).not.toContain(real);
    }
    const procesos = ejecutarEn(nombre, ['sh', '-c', 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\\0" "\\n"; cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " "']);
    expect(procesos.salida).not.toContain(real);
    const historia = docker(['history', '--no-trunc', nucleo.imagenEspacio], true).salida + docker(['image', 'inspect', nucleo.imagenEspacio], true).salida;
    expect(historia).not.toContain(real);
    expect(historia).not.toMatch(/sk-ant-(oat|api)\d\d-[A-Za-z0-9_-]{10,}/);
    expect(ejecutarEn(nombre, ['sh', '-c', 'ls -a ~/.claude/.credentials.json /root/.claude/.credentials.json 2>/dev/null']).salida).toBe('');

    const registro = fs.readFileSync(nucleo.archivoRegistro, 'utf8');
    for (const s of [real, cmt, cct]) expect(registro).not.toContain(s);
    const base = fs.readFileSync(nucleo.rutaBase).toString('latin1') + (fs.existsSync(`${nucleo.rutaBase}-wal`) ? fs.readFileSync(`${nucleo.rutaBase}-wal`).toString('latin1') : '');
    for (const s of [real, cmt, cct]) expect(base).not.toContain(s);
    expect(textoArchivos(nucleo.raizEspacios)).not.toContain(real);
    expect(textoArchivos(nucleo.raizCursos)).not.toContain(real);
  });

  test('la prueba recibe solo la identidad firmada por el núcleo, sin cookies ni credenciales', async ({ nucleo }) => {
    const clave = nucleo.ejecutar(['clave-publica']).stdout.trim();
    await esperarRespuesta(() => enPrueba(profe, a, '/salud'), (r) => r.status === 200, ESPERA_RECARGA_MS, 'la prueba responde');
    const eco = await enPrueba(profe, a, '/espia/eco', {
      bearer: 'robado',
      encabezados: {
        'x-campus-identidad': 'eyJ2IjoxfQ.falsa',
        'X-Campus-Otro': 'x',
        'proxy-authorization': 'Basic eA==',
        cookie: `campusia_sesion=${profe.sesion}; otra=1`,
      },
    });
    expect(eco.status).toBe(200);
    const h = eco.json.encabezados;
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h['proxy-authorization']).toBeUndefined();
    expect(h['x-campus-otro']).toBeUndefined();
    expect(firmaValida(h['x-campus-identidad'], clave)).toBe(true);
    const carga = leerIdentidad(h['x-campus-identidad']);
    expect(carga.curso).toBe(a);
    expect(carga.rol).toBe('dueño');
    expect(carga.email).toBe(PROFE_AUSTRAL);

    const cookie = await enPrueba(profe, a, '/espia/cookie');
    expect(cookie.status).toBe(200);
    expect(cookie.setCookies).toEqual([]);

    await enPrueba(profe, a, '/espia/registro');
    const otro = await profe.pedir('POST', '/espia/eco', { x: 1 }, { sub: `${a}-prueba`, origen: `http://${b}-prueba.campusia.prueba:${nucleo.puerto}` });
    expect(otro.status).toBe(403);
    const registro = await enPrueba(profe, a, '/espia/registro');
    expect(registro.json.filter((x: any) => x.metodo === 'POST')).toEqual([]);
    const bien = await profe.pedir('POST', '/espia/eco', { x: 1 }, { sub: `${a}-prueba` });
    expect(bien.status).toBe(200);
  });

  test('las variables de la plataforma en la prueba son las del espacio, sin secretos', async ({ nucleo }) => {
    const e = await enPrueba(profe, a, '/espia/entorno');
    expect(e.status).toBe(200);
    const claves: string[] = e.json.claves;
    for (const prohibida of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'SESSION_SECRET', 'IDENTIDAD_CLAVE_PRIVADA', 'DOCKER_HOST', 'DATABASE_URL', 'MODELO_DESTINO']) {
      expect(claves).not.toContain(prohibida);
    }
    expect(JSON.stringify(e.json)).not.toContain(nucleo.tokenReal);
    expect(e.json.variables.CAMPUSIA_CURSO).toBe(a);
  });
});
