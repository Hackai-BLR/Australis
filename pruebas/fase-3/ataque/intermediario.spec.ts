import crypto from 'node:crypto';
import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { reautenticar } from '../../comun/sesion.ts';
import { apiDeCurso, pedirApiCursos, sesion, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { docker } from '../../fase-2/lib/docker.ts';
import { cuerpoMensaje, cursoConEspacio, entornoEspacio, espacioListo, filasUso, llamarModelo, nombreEspacio, tokenModelo, urlModelo } from '../lib/agente.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let a = '';
let b = '';
let ta = '';
let tb = '';
let base = '';
let ruta = '';
let profe: Cliente;

function sinReenvio(nucleo: any, antes: number, filas: number) {
  expect(nucleo.modelo.pedidos.length, 'no tenía que llegar nada al destino').toBe(antes);
  expect(filasUso(nucleo).length).toBe(filas);
}

test.describe('el intermediario solo sirve al espacio de cada curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    const otro = await sesion(nucleo, PROFE2_AUSTRAL);
    a = await cursoConEspacio(profe, { nombre: 'Curso A' });
    b = await cursoConEspacio(otro, { nombre: 'Curso B' });
    ta = tokenModelo(nucleo, a);
    tb = tokenModelo(nucleo, b);
    base = urlModelo(nucleo, a);
    ruta = `${new URL(base).pathname}/v1/messages`;
    expect(ta).not.toBe(tb);
    expect(urlModelo(nucleo, b)).toBe(base);
  });

  test('sin credencial válida responde 401 y no reenvía', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const filas = filasUso(nucleo).length;
    const cuerpo = cuerpoMensaje('hola');
    const inventado = `cmt_${crypto.randomBytes(32).toString('base64url')}`;
    const personal = `cia_${crypto.randomBytes(32).toString('base64url')}`;
    const casos: Array<[string, Record<string, string>]> = [
      ['sin nada', {}],
      ['inventado', { authorization: `Bearer ${inventado}` }],
      ['con un caracter de más', { authorization: `Bearer ${ta}x` }],
      ['con un caracter de menos', { authorization: `Bearer ${ta.slice(0, -1)}` }],
      ['en mayúsculas', { authorization: `Bearer ${ta.toUpperCase()}` }],
      ['sin Bearer', { authorization: ta }],
      ['Basic', { authorization: `Basic ${Buffer.from(`x:${ta}`).toString('base64')}` }],
      ['doble', { authorization: `Bearer ${ta}`, 'x-api-key': ta }],
      ['token del curso publicado', { authorization: `Bearer ${tokenDeCurso(nucleo, a)}` }],
      ['token de curso del espacio', { authorization: `Bearer ${entornoEspacio(nucleo, a).CAMPUSIA_TOKEN_CURSO}` }],
      ['token personal', { authorization: `Bearer ${personal}` }],
      ['cookie de sesión', { cookie: `campusia_sesion=${profe.sesion}` }],
      ['el token real', { authorization: `Bearer ${nucleo.tokenReal}` }],
      ['el token real en x-api-key', { 'x-api-key': nucleo.tokenReal }],
    ];
    for (const [nombre, encabezados] of casos) {
      const r = await llamarModelo(base, ruta, { cuerpo, encabezados });
      expect(r.status, nombre).toBe(401);
      expect(r.json?.type, nombre).toBe('error');
      expect(r.json?.error?.type, nombre).toBe('authentication_error');
      expect(r.texto).not.toContain(nucleo.tokenReal);
    }
    sinReenvio(nucleo, antes, filas);
  });

  test('rutas y métodos fuera de la lista no se reenvían', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const filas = filasUso(nucleo).length;
    const pre = new URL(base).pathname;
    const rutas = [
      `${pre}/v1/models`,
      `${pre}/v1/complete`,
      `${pre}/api/oauth/profile`,
      `${pre}/api/organizations`,
      `${pre}/v1/messages/../../api/oauth/profile`,
      `${pre}/v1/%2e%2e/api/oauth/profile`,
      `${pre}/v1/messages%2f..%2f..%2fapi`,
      `${pre}/v1/messages%5c..`,
      `${pre}//v1/messages`,
      `${pre}`,
      '/v1/messages',
      '/api/yo',
      '/api/cursos',
    ];
    for (const r of rutas) {
      const res = await llamarModelo(base, r, { token: ta, cuerpo: cuerpoMensaje('hola') });
      expect([400, 404], `${r}: ${res.status}`).toContain(res.status);
    }
    for (const metodo of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await llamarModelo(base, ruta, { metodo, token: ta, cuerpo: metodo === 'GET' ? undefined : cuerpoMensaje('hola') });
      expect([404, 405], `${metodo}: ${res.status}`).toContain(res.status);
    }
    sinReenvio(nucleo, antes, filas);
  });

  test('las herramientas del servidor y el contenido desde URL se rechazan sin reenviar', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const filas = filasUso(nucleo).length;
    const fuera = 'https://atacante.invalid/?d=datos';
    const casos: Array<[string, any]> = [
      ['web_fetch', cuerpoMensaje(`traé ${fuera}`, { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] })],
      ['web_search', cuerpoMensaje('buscá', { tools: [{ type: 'web_search_20250305', name: 'web_search' }] })],
      ['code_execution', cuerpoMensaje('corré', { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] })],
      [
        'mezcla',
        cuerpoMensaje('x', {
          tools: [
            { name: 'Read', description: 'Lee', input_schema: { type: 'object', properties: {} } },
            { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1 },
          ],
        }),
      ],
      ['mcp_servers', cuerpoMensaje('x', { mcp_servers: [{ type: 'url', url: fuera, name: 'afuera' }] })],
      ['imagen por URL', { ...cuerpoMensaje('x'), messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: fuera } }] }] }],
      ['documento por URL', { ...cuerpoMensaje('x'), messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: fuera } }] }] }],
      [
        'URL en un resultado',
        {
          ...cuerpoMensaje('x'),
          messages: [
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'url', url: fuera } }] }] },
          ],
        },
      ],
      ['system por URL', { ...cuerpoMensaje('x'), system: [{ type: 'document', source: { type: 'url', url: fuera } }] }],
    ];
    for (const destino of [ruta, `${ruta}/count_tokens`]) {
      for (const [nombre, cuerpo] of casos) {
        const r = await llamarModelo(base, destino, { token: ta, cuerpo });
        expect(r.status, `${nombre} en ${destino}: ${r.texto}`).toBe(400);
        expect(r.json?.type).toBe('error');
        expect(r.json?.error?.type).toBe('invalid_request_error');
      }
    }
    sinReenvio(nucleo, antes, filas);
    const propia = await llamarModelo(base, ruta, {
      token: ta,
      cuerpo: cuerpoMensaje('hola', { tools: [{ name: 'Read', description: 'Lee', input_schema: { type: 'object', properties: {} } }] }),
    });
    expect(propia.status, propia.texto).toBe(200);
    expect(nucleo.modelo.pedidos.length).toBe(antes + 1);
  });

  test('un cuerpo de más de 32 MiB se rechaza sin reenviar', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const filas = filasUso(nucleo).length;
    const enorme = JSON.stringify(cuerpoMensaje('x'.repeat(33 * 1024 * 1024)));
    let estado = 0;
    try {
      estado = (await llamarModelo(base, ruta, { token: ta, crudo: enorme })).status;
    } catch {
      estado = 413;
    }
    expect(estado).toBe(413);
    sinReenvio(nucleo, antes, filas);
  });

  test('el uso se atribuye solo por el token, aunque el cliente diga otro curso', async ({ nucleo }) => {
    const filasA = filasUso(nucleo, a).length;
    const filasB = filasUso(nucleo, b).length;
    const r = await llamarModelo(base, ruta, {
      token: ta,
      cuerpo: cuerpoMensaje('hola'),
      encabezados: { 'x-campus-curso': b, 'x-curso': b, 'x-campusia-curso': b },
    });
    expect(r.status).toBe(200);
    expect(filasUso(nucleo, a).length).toBe(filasA + 1);
    expect(filasUso(nucleo, b).length).toBe(filasB);
    const rb = await llamarModelo(base, ruta, { token: tb, cuerpo: cuerpoMensaje('hola') });
    expect(rb.status).toBe(200);
    expect(filasUso(nucleo, b).length).toBe(filasB + 1);
  });

  test('el token de modelo no sirve fuera del intermediario y /modelo no existe en otras escuchas', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const api = new Cliente(nucleo);
    api.bearer = ta;
    for (const r of ['/api/yo', `/api/cursos/${a}`, `/api/cursos/${a}/agente`, '/api/mis-cursos']) {
      expect((await api.get(r)).status, r).toBe(401);
    }
    expect((await api.post(`/api/cursos/${a}/publicar`, {})).status).toBe(401);
    const principal = await profe.post('/modelo/v1/messages', cuerpoMensaje('hola'), { bearer: ta });
    expect(principal.status).toBe(404);
    const enBarra = await profe.post('/modelo/v1/messages', cuerpoMensaje('hola'), { bearer: ta, sub: a });
    expect([401, 404]).toContain(enBarra.status);
    const apiCursos = apiDeCurso(nucleo, a).replace(/\/$/, '');
    expect((await pedirApiCursos(`${apiCursos}/api/curso/yo`, ta)).status).toBe(401);
    expect((await pedirApiCursos(`${apiCursos}/modelo/v1/messages`, ta, 'POST')).status).toBe(404);
    const espacios = entornoEspacio(nucleo, a).CAMPUSIA_API!.replace(/\/$/, '');
    expect((await pedirApiCursos(`${espacios}/api/curso/yo`, ta)).status).toBe(401);
    expect((await pedirApiCursos(`${espacios}/api/curso/inscriptos`, ta)).status).toBe(401);
    expect((await pedirApiCursos(`${espacios}/api/yo`, ta)).status).toBe(404);
    expect(nucleo.modelo.pedidos.length).toBe(antes);
  });

  test('cuando el espacio se recrea, el token anterior deja de servir', async ({ nucleo }) => {
    const viejo = ta;
    docker(['rm', '-f', nombreEspacio(nucleo, a)], true);
    await espacioListo(profe, a);
    const nuevo = tokenModelo(nucleo, a);
    expect(nuevo).toMatch(/^cmt_/);
    expect(nuevo).not.toBe(viejo);
    const antes = nucleo.modelo.pedidos.length;
    const r = await llamarModelo(base, ruta, { token: viejo, cuerpo: cuerpoMensaje('hola') });
    expect(r.status).toBe(401);
    expect(nucleo.modelo.pedidos.length).toBe(antes);
    const ok = await llamarModelo(urlModelo(nucleo, a), ruta, { token: nuevo, cuerpo: cuerpoMensaje('hola') });
    expect(ok.status).toBe(200);
    const huellas = nucleo.consultar('SELECT token_modelo_huella FROM espacios WHERE curso_id = ?', a);
    expect(huellas).toHaveLength(1);
    expect(huellas[0].token_modelo_huella).not.toContain(nuevo);
  });
});
