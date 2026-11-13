import fs from 'node:fs';
import path from 'node:path';
import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE3_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL } from '../fixtures.ts';
import { reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  apiDeCurso,
  cursoListo,
  inscribirOk,
  idAleatorio,
  pedirApiCursos,
  sesion,
  tokenDeCurso,
} from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let a = '';
let b = '';
let tokenA = '';
let tokenB = '';
let api = '';

test.describe('token del curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const lucia = await sesion(nucleo, PROFE_AUSTRAL);
    const martin = await sesion(nucleo, PROFE3_AUSTRAL);
    a = idAleatorio('tka');
    b = idAleatorio('tkb');
    await cursoListo(lucia, { id: a, nombre: 'Token A' });
    await cursoListo(martin, { id: b, nombre: 'Token B' });
    await inscribirOk(lucia, a, [ALUMNO_AUSTRAL]);
    await inscribirOk(martin, b, [ALUMNA2_AUSTRAL]);
    tokenA = tokenDeCurso(nucleo, a);
    tokenB = tokenDeCurso(nucleo, b);
    api = apiDeCurso(nucleo, a).replace(/\/$/, '');
    expect(tokenA).toMatch(/^cct_/);
    expect(tokenB).toMatch(/^cct_/);
    expect(tokenA).not.toBe(tokenB);
  });

  test('cada token solo ve su curso', async () => {
    const ya = await pedirApiCursos(`${api}/api/curso/yo`, tokenA);
    const yb = await pedirApiCursos(`${api}/api/curso/yo`, tokenB);
    expect(ya.json.id).toBe(a);
    expect(yb.json.id).toBe(b);
    const ia = await pedirApiCursos(`${api}/api/curso/inscriptos`, tokenA);
    const emails = ia.json.map((x: any) => x.email);
    expect(emails).toContain(ALUMNO_AUSTRAL);
    expect(emails).not.toContain(ALUMNA2_AUSTRAL);
    expect(emails).not.toContain(PROFE3_AUSTRAL);
    for (const ruta of [`/api/curso/yo?curso=${b}`, `/api/curso/inscriptos?curso=${b}`, `/api/curso/${b}/inscriptos`, `/api/cursos/${b}/inscriptos`]) {
      const r = await pedirApiCursos(`${api}${ruta}`, tokenA, 'GET', { 'x-campus-curso': b });
      if (r.status === 200) expect(JSON.stringify(r.json)).not.toContain(ALUMNA2_AUSTRAL);
      else expect([400, 401, 403, 404]).toContain(r.status);
    }
  });

  test('el token de un curso no sirve en la plataforma', async ({ nucleo }) => {
    const c = new Cliente(nucleo);
    c.bearer = tokenA;
    for (const [m, ruta, cuerpo] of [
      ['GET', '/api/yo'],
      ['GET', '/api/mis-cursos'],
      ['GET', `/api/cursos/${a}`],
      ['GET', `/api/cursos/${a}/inscriptos`],
      ['GET', `/api/cursos/${b}/inscriptos`],
      ['POST', `/api/cursos/${b}/inscriptos`, { emails: [ALUMNO_AUSTRAL], rol: 'alumno' }],
      ['POST', '/api/cursos', { nombre: 'x', subdominio: idAleatorio('t'), periodo: 'x' }],
      ['GET', '/api/admin/personas'],
    ] as Array<[string, string, any]>) {
      const r = await c.pedir(m, ruta, cuerpo);
      expect(r.status, `${m} ${ruta}`).toBe(401);
    }
    const principal = new Cliente(nucleo);
    principal.bearer = tokenA;
    expect((await principal.get('/api/curso/yo')).status).toBe(404);
    expect((await principal.get('/api/curso/inscriptos')).status).toBe(404);
  });

  test('ni cookies ni tokens personales sirven en la API para cursos', async ({ nucleo }) => {
    const lucia = await sesion(nucleo, PROFE_AUSTRAL);
    const t = { json: { token: `cia_${'P'.repeat(43)}` } };
    for (const token of [t.json.token, lucia.sesion!, 'cct_' + 'A'.repeat(43), tokenA.slice(0, -1), `${tokenA}x`, '']) {
      const r = await pedirApiCursos(`${api}/api/curso/yo`, token || null);
      expect(r.status, token.slice(0, 8)).toBe(401);
    }
    const conCookie = await pedirApiCursos(`${api}/api/curso/inscriptos`, null, 'GET', { cookie: `campusia_sesion=${lucia.sesion}` });
    expect(conCookie.status).toBe(401);
    const minus = await pedirApiCursos(`${api}/api/curso/yo`, null, 'GET', { authorization: `bearer ${tokenA.toUpperCase()}` });
    expect(minus.status).toBe(401);
  });

  test('la escucha para cursos no expone la plataforma', async () => {
    for (const ruta of ['/', '/api/yo', '/api/config', '/api/mis-cursos', '/api/admin/personas', `/api/cursos/${a}`, '/api/login/codigo', '/index.html', '/api/curso/../yo']) {
      for (const token of [tokenA, null]) {
        const r = await pedirApiCursos(`${api}${ruta}`, token);
        expect([401, 404], `${ruta} ${token ? 'con' : 'sin'} token`).toContain(r.status);
        expect(r.texto).not.toContain('id="raiz"');
      }
    }
    const post = await pedirApiCursos(`${api}/api/login/codigo`, tokenA, 'POST', { 'content-type': 'application/json' });
    expect([401, 404, 405]).toContain(post.status);
    const escritura = await pedirApiCursos(`${api}/api/curso/inscriptos`, tokenA, 'POST', { 'content-type': 'application/json' });
    expect([404, 405]).toContain(escritura.status);
  });

  test('el token del curso no se guarda en claro ni aparece en el repo', async ({ nucleo }) => {
    const db = fs.readFileSync(nucleo.rutaBase);
    const wal = fs.existsSync(`${nucleo.rutaBase}-wal`) ? fs.readFileSync(`${nucleo.rutaBase}-wal`) : Buffer.alloc(0);
    for (const tok of [tokenA, tokenB]) {
      expect(db.includes(Buffer.from(tok))).toBe(false);
      expect(wal.includes(Buffer.from(tok))).toBe(false);
      expect(db.includes(Buffer.from(tok.slice(4)))).toBe(false);
    }
    const repo = path.join(nucleo.raizCursos, a);
    const buscar = (dir: string): boolean =>
      fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name !== 'datos' && buscar(p);
        return e.isFile() && fs.readFileSync(p).includes(Buffer.from(tokenA));
      });
    expect(buscar(repo)).toBe(false);
    expect(fs.readFileSync(nucleo.archivoRegistro, 'utf8')).not.toContain(tokenA);
    const aud = nucleo.consultar('SELECT detalle FROM auditoria').map((x: any) => x.detalle).join('\n');
    expect(aud).not.toContain(tokenA);
  });
});
