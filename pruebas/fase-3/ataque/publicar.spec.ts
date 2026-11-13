import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { auditoria, inscribirOk, sesion } from '../../fase-2/lib/cursos.ts';
import { corriendo, docker, ejecutarEn, nombreContenedor } from '../../fase-2/lib/docker.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  ESPERA_RECARGA_MS,
  archivoEnRama,
  contenedorIdDe,
  cursoConEspacio,
  enPublicado,
  entornoEspacio,
  esperarPublicacion,
  esperarRespuesta,
  git,
  guion,
  guionAgregarRuta,
  guionBash,
  guionEscribir,
  pedidoOk,
  pedirAlAgente,
  finDe,
  publicar,
  publicarOk,
} from '../lib/agente.ts';
import type { PasoGuion } from '../lib/modelo-falso.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let profe: Cliente;
let alumno: Cliente;

const LINEA_BASE = 'const base = abrirBase(configuracion.datos);';
const LINEA_ROTA = 'if (process.env.PORT) process.exit(3);';

function guionEditarIndex(viejo: string, nuevo: string): PasoGuion[] {
  return [
    { herramientas: [{ nombre: 'Read', entrada: { file_path: '/repo/servidor/index.ts' } }] },
    { herramientas: [{ nombre: 'Edit', entrada: { file_path: '/repo/servidor/index.ts', old_string: viejo, new_string: nuevo } }] },
    { texto: 'Listo.' },
  ];
}

function sonda(archivo: string) {
  const codigo = [
    "const fs=require('fs'),os=require('os');",
    "const red=Object.keys(os.networkInterfaces()).filter((n)=>n!=='lo');",
    "const cap=(fs.readFileSync('/proc/self/status','utf8').split(String.fromCharCode(10)).find((l)=>l.startsWith('CapEff'))||'').split(':').pop().trim();",
    "fs.mkdirSync('dist',{recursive:true});",
    `fs.writeFileSync('dist/${archivo}',JSON.stringify({uid:process.getuid(),red,cap}));`,
  ].join('');
  return `node -e "${codigo}"`;
}

function valor(r: { status: number; json: any }) {
  return r.status === 200 ? r.json?.valor : undefined;
}

interface Foto {
  main: string;
  prueba: string;
  etiquetas: string;
  contenedor: string | null;
  version: number | null;
  versiones: number;
}

async function foto(nucleo: any): Promise<Foto> {
  const c = await profe.get(`/api/cursos/${id}`);
  return {
    main: git(nucleo, id, ['rev-parse', 'main']).salida,
    prueba: git(nucleo, id, ['rev-parse', 'prueba']).salida,
    etiquetas: git(nucleo, id, ['tag', '-l']).salida,
    contenedor: contenedorIdDe(nombreContenedor(nucleo.prefijo, id)),
    version: c.json.version_publicada,
    versiones: (await profe.get(`/api/cursos/${id}/versiones`)).json.versiones.length,
  };
}

async function sinCambios(nucleo: any, antes: Foto) {
  const despues = await foto(nucleo);
  expect(despues.main).toBe(antes.main);
  expect(despues.prueba).toBe(antes.prueba);
  expect(despues.etiquetas).toBe(antes.etiquetas);
  expect(despues.contenedor).toBe(antes.contenedor);
  expect(despues.version).toBe(antes.version);
  expect(despues.versiones).toBe(antes.versiones);
  expect(corriendo(nombreContenedor(nucleo.prefijo, id))).toBe(true);
  expect(valor(await enPublicado(alumno, id, '/saludo'))).toBe('UNO');
  const sobrantes = docker(['ps', '-a', '--filter', `label=campusia.prefijo=${nucleo.prefijo}`, '--filter', `label=campusia.curso=${id}`, '--format', '{{.Names}}'], true)
    .salida.split('\n')
    .filter((x) => x && x !== nombreContenedor(nucleo.prefijo, id) && !x.includes('-espacio-'));
  expect(sobrantes).toEqual([]);
}

test.describe('lo que no pasa la verificación o no arranca no se publica', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso que se Publica' });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
    guion(nucleo, 'base', guionAgregarRuta('/saludo', 'UNO'));
    await pedidoOk(profe, id, 'Ruta base [guion:base]');
    const p = await publicarOk(profe, id);
    expect(p.version).toBe(1);
  });

  test('una versión que no arranca no se publica y el tráfico sigue en la anterior', async ({ nucleo }) => {
    guion(nucleo, 'no-arranca', guionEditarIndex(LINEA_BASE, `${LINEA_ROTA}\n${LINEA_BASE}`));
    await pedidoOk(profe, id, 'Romper el arranque [guion:no-arranca]');
    const antes = await foto(nucleo);
    const p = await publicar(profe, id);
    expect(p.estado).toBe('error');
    expect(p.etapa).toBe('arranque');
    expect(p.version).toBeNull();
    expect(p.error).toBeTruthy();
    await sinCambios(nucleo, antes);
    const c = await profe.get(`/api/cursos/${id}`);
    expect(c.json.cambios_sin_publicar).toBe(true);
    expect(auditoria(nucleo, 'publicacion_fallida').some((e) => e.detalle.includes(id))).toBe(true);
    guion(nucleo, 'arreglar', guionEditarIndex(`${LINEA_ROTA}\n${LINEA_BASE}`, LINEA_BASE));
    await pedidoOk(profe, id, 'Arreglar el arranque [guion:arreglar]');
  });

  test('una versión con pruebas que fallan no se publica y el registro muestra la falla', async ({ nucleo }) => {
    guion(
      nucleo,
      'falla',
      guionEscribir({
        'servidor/falla.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('falla a propósito', () => {\n  assert.equal(1, 2);\n});\n",
      }),
    );
    await pedidoOk(profe, id, 'Agregar una prueba [guion:falla]');
    const antes = await foto(nucleo);
    const p = await publicar(profe, id);
    expect(p.estado).toBe('error');
    expect(p.etapa).toBe('pruebas');
    expect(p.registro).toContain('falla a propósito');
    await sinCambios(nucleo, antes);
    guion(nucleo, 'sin-falla', guionBash(['rm servidor/falla.test.ts']));
    const { respuesta } = await pedidoOk(profe, id, 'Sacar la prueba [guion:sin-falla]');
    expect(respuesta.archivos).toEqual([{ ruta: 'servidor/falla.test.ts', cambio: 'borrado' }]);
  });

  test('una versión con errores de tipos no se publica', async ({ nucleo }) => {
    guion(nucleo, 'tipos', guionEscribir({ 'servidor/tipos-rotos.ts': "export const numero: number = 'texto';\n" }));
    await pedidoOk(profe, id, 'Agregar un archivo [guion:tipos]');
    const antes = await foto(nucleo);
    const p = await publicar(profe, id);
    expect(p.estado).toBe('error');
    expect(['pruebas', 'tipos', 'compilacion']).toContain(p.etapa);
    expect(p.registro).toContain('tipos-rotos.ts');
    await sinCambios(nucleo, antes);
    guion(nucleo, 'sin-tipos', guionBash(['rm servidor/tipos-rotos.ts']));
    await pedidoOk(profe, id, 'Sacar el archivo [guion:sin-tipos]');
  });

  test('la verificación corre sin red y sin secretos', async ({ nucleo }) => {
    const env = entornoEspacio(nucleo, id);
    const espacios = env.CAMPUSIA_API!.replace(/\/$/, '');
    const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? '';
    const prueba = `import { test } from 'node:test';
import assert from 'node:assert/strict';

test('la verificación no ve secretos ni tiene red', async () => {
  const claves = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CAMPUSIA_TOKEN|SESSION_SECRET|IDENTIDAD_|DOCKER_HOST|DATABASE_URL|HTTPS?_PROXY)/i.test(k));
  assert.deepEqual(claves, []);
  for (const destino of ['http://1.1.1.1/', 'https://registry.npmjs.org/', ${JSON.stringify(`${espacios}/salud`)}, ${JSON.stringify(proxy)}]) {
    await assert.rejects(fetch(destino, { signal: AbortSignal.timeout(4000) }), destino);
  }
});
`;
    guion(nucleo, 'ci', guionEscribir({ 'servidor/aislamiento.test.ts': prueba }));
    await pedidoOk(profe, id, 'Agregar la prueba de aislamiento [guion:ci]');
    const p = await publicarOk(profe, id);
    expect(p.version).toBe(2);
    expect(p.registro).not.toContain(nucleo.tokenReal);
    expect(p.registro).not.toContain(env.ANTHROPIC_AUTH_TOKEN!);
    await esperarRespuesta(() => enPublicado(alumno, id, '/saludo'), (r) => valor(r) === 'UNO', 30_000, 'el curso sigue publicado');
  });

  test('no hay dos publicaciones a la vez ni publicaciones mientras corre el agente', async ({ nucleo }) => {
    guion(nucleo, 'tres', guionAgregarRuta('/tres', 'TRES'));
    await pedidoOk(profe, id, 'Ruta tres [guion:tres]');
    const r1 = await profe.post(`/api/cursos/${id}/publicar`, {});
    expect(r1.status).toBe(202);
    const r2 = await profe.post(`/api/cursos/${id}/publicar`, {});
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe('publicacion_en_curso');
    const v = await profe.post(`/api/cursos/${id}/versiones/1/volver`, {});
    expect(v.status).toBe(409);
    expect(v.json.error).toBe('publicacion_en_curso');
    const ag = await pedirAlAgente(profe, id, 'Otro cambio');
    expect(ag.status).toBe(409);
    expect(ag.json.error).toBe('publicacion_en_curso');
    const fin = await esperarPublicacion(profe, id, r1.json.id);
    expect(fin.estado, `${fin.etapa}: ${fin.error}`).toBe('ok');
    expect(fin.version).toBe(3);

    guion(nucleo, 'lento', guionBash(['sleep 25', 'echo hola > lento.txt']));
    const enCurso = pedirAlAgente(profe, id, 'Algo lento [guion:lento]');
    await esperarRespuesta(() => profe.get(`/api/cursos/${id}/agente`), (r) => r.json?.en_curso === true, 60_000, 'el agente está trabajando');
    const pub = await profe.post(`/api/cursos/${id}/publicar`, {});
    expect(pub.status).toBe(409);
    expect(pub.json.error).toBe('agente_ocupado');
    const vol = await profe.post(`/api/cursos/${id}/versiones/1/volver`, {});
    expect(vol.status).toBe(409);
    expect(vol.json.error).toBe('agente_ocupado');
    const otro = await pedirAlAgente(profe, id, 'Otro más');
    expect(otro.status).toBe(409);
    expect(otro.json.error).toBe('agente_ocupado');
    const r = await enCurso;
    expect(finDe(r)?.estado).toBe('ok');
  });

  test('volver a versiones que no existen falla sin tocar nada', async ({ nucleo }) => {
    const antes = await foto(nucleo);
    for (const n of ['0', '-1', '99', 'abc', '1.5', '1%2f..']) {
      const r = await profe.post(`/api/cursos/${id}/versiones/${n}/volver`, {});
      expect([400, 404], n).toContain(r.status);
    }
    const despues = await foto(nucleo);
    expect(despues.main).toBe(antes.main);
    expect(despues.etiquetas).toBe(antes.etiquetas);
    expect(despues.version).toBe(antes.version);
  });

  test('si el agente deja cambios a medias, el pedido cortado igual queda guardado', async ({ nucleo }) => {
    guion(nucleo, 'cortado', guionBash(['sleep 10', 'echo cortado > cortado.txt']));
    const r = await pedirAlAgente(profe, id, 'Algo que se corta [guion:cortado]', { cortarAlInicio: true });
    expect(r.status).toBe(200);
    await esperarRespuesta(
      () => profe.get(`/api/cursos/${id}/agente`),
      (x) => x.json?.en_curso === false && x.json.mensajes[x.json.mensajes.length - 1]?.estado === 'ok',
      ESPERA_RECARGA_MS,
      'la ejecución sigue sin el cliente y termina',
    );
    const ultimo = (await profe.get(`/api/cursos/${id}/agente`)).json.mensajes.at(-1);
    expect(ultimo.archivos).toEqual([{ ruta: 'cortado.txt', cambio: 'agregado' }]);
    expect(git(nucleo, id, ['show', 'prueba:cortado.txt']).salida).toBe('cortado');
  });

  test('al publicar, el código del curso no corre con red ni como root al armar la imagen', async ({ nucleo }) => {
    const paquete = JSON.parse(archivoEnRama(nucleo, id, 'prueba', 'package.json')!);
    paquete.scripts.postinstall = sonda('instalacion.json');
    paquete.scripts.build = `${paquete.scripts.build} && ${sonda('compilacion.json')}`;
    guion(nucleo, 'paquete', guionEscribir({ 'package.json': `${JSON.stringify(paquete, null, 2)}\n` }));
    const { respuesta } = await pedidoOk(profe, id, 'Cambiar los scripts [guion:paquete]');
    expect(respuesta.archivos).toEqual([{ ruta: 'package.json', cambio: 'modificado' }]);
    const p = await publicarOk(profe, id);
    const nombre = nombreContenedor(nucleo.prefijo, id);
    const leer = (archivo: string) => {
      const r = ejecutarEn(nombre, ['cat', `/app/dist/${archivo}`]);
      expect(r.estado, `${archivo}: ${r.salida}`).toBe(0);
      return JSON.parse(r.salida);
    };
    const compilacion = leer('compilacion.json');
    expect(compilacion.red, 'la compilación que termina en la imagen corrió con red').toEqual([]);
    expect(compilacion.uid).not.toBe(0);
    expect(compilacion.cap).toMatch(/^0+$/);
    const instalacion = leer('instalacion.json');
    expect(instalacion.uid, 'los scripts de instalación corrieron como root').not.toBe(0);
    expect(instalacion.cap).toMatch(/^0+$/);
    expect(p.registro).not.toContain(nucleo.tokenReal);
    await esperarRespuesta(() => enPublicado(alumno, id, '/saludo'), (r) => valor(r) === 'UNO', 30_000, 'el curso sigue publicado');
  });
});
