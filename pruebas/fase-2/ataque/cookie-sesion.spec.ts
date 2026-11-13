import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL } from '../fixtures.ts';
import { COOKIE_SESION, DOMINIO } from '../../comun/entorno.ts';
import { atributosCookie, type Respuesta } from '../../comun/http.ts';
import { TIEMPO_PRUEBA_DOCKER, cursoListo, getCurso, idAleatorio, inscribirOk, sesion } from '../lib/cursos.ts';

const test = crearTestCursos({ espia: true });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

function borrados(r: Respuesta) {
  return r.setCookies
    .map(atributosCookie)
    .filter((c) => c.nombre === COOKIE_SESION)
    .map((c) => ({ valor: c.valor, dominio: c.atributos.domain ?? null, ruta: c.atributos.path, maxAge: c.atributos['max-age'] }));
}

let id = '';

test.describe('cookies de sesión plantadas desde un curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = idAleatorio('galle');
    await cursoListo(profe, { id, nombre: `Galletitas ${id}` });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL]);
  });

  test('con dos cookies de sesión distintas nadie entra en la cuenta de otro', async ({ nucleo }) => {
    const victima = await sesion(nucleo, ALUMNO_AUSTRAL);
    const atacante = await sesion(nucleo, ALUMNA2_AUSTRAL);
    for (const cookie of [
      `${COOKIE_SESION}=${atacante.sesion}; ${COOKIE_SESION}=${victima.sesion}`,
      `${COOKIE_SESION}=${victima.sesion}; ${COOKIE_SESION}=${atacante.sesion}`,
    ]) {
      for (const sub of [undefined, id]) {
        const r = await victima.get('/api/yo', { cookie, sub });
        expect(r.status, `${sub ?? 'plataforma'}: ${r.texto}`).toBe(401);
        expect(r.texto).not.toContain(ALUMNA2_AUSTRAL);
        const b = borrados(r);
        expect(b).toContainEqual({ valor: '', dominio: DOMINIO, ruta: '/api', maxAge: '0' });
        expect(b).toContainEqual({ valor: '', dominio: DOMINIO, ruta: '/api/yo', maxAge: '0' });
        expect(b.some((c) => c.ruta === '/' && c.dominio !== null), 'la cookie verdadera no se borra').toBe(false);
      }
    }
    const sola = await victima.get('/api/yo');
    expect(sola.status).toBe(200);
    expect(sola.json.usuario.email).toBe(ALUMNO_AUSTRAL);
  });

  test('en el subdominio del curso tampoco se reenvía y se borran también las del propio curso', async ({ nucleo }) => {
    const victima = await sesion(nucleo, ALUMNO_AUSTRAL);
    const atacante = await sesion(nucleo, ALUMNA2_AUSTRAL);
    await getCurso(victima, id, '/espia/registro');
    const cookie = `${COOKIE_SESION}=${atacante.sesion}; ${COOKIE_SESION}=${victima.sesion}`;
    const r = await getCurso(victima, id, '/espia/eco', { cookie });
    expect(r.status).toBe(401);
    const b = borrados(r);
    expect(b).toContainEqual({ valor: '', dominio: DOMINIO, ruta: '/espia', maxAge: '0' });
    expect(b).toContainEqual({ valor: '', dominio: null, ruta: '/', maxAge: '0' });
    const registro = await getCurso(victima, id, '/espia/registro');
    expect(registro.status).toBe(200);
    expect(registro.json.filter((p: any) => p.ruta === '/espia/eco')).toEqual([]);
  });

  test('una cookie basura plantada por el curso no deja a la persona afuera', async ({ nucleo, paginaComo }) => {
    const victima = await sesion(nucleo, ALUMNO_AUSTRAL);
    const pagina = await paginaComo(victima);
    const curso = await pagina.goto(nucleo.url(`${id}-curso`, '/'));
    expect(curso?.status()).toBe(200);
    await pagina.evaluate((d) => {
      document.cookie = `campusia_sesion=basura; Domain=${d}; Path=/api`;
      document.cookie = `campusia_sesion=basura; Domain=${d}; Path=/api/yo`;
    }, DOMINIO);
    expect((await pagina.context().cookies()).filter((c) => c.name === COOKIE_SESION).length).toBe(3);
    await pagina.goto(nucleo.url(undefined, '/'));
    const estados: number[] = [];
    for (let i = 0; i < 3; i++) {
      estados.push(await pagina.evaluate(async () => (await fetch('/api/yo')).status));
    }
    expect(estados[estados.length - 1]).toBe(200);
    const yo = await pagina.evaluate(async () => (await fetch('/api/yo')).json());
    expect(yo.usuario.email).toBe(ALUMNO_AUSTRAL);
    const quedan = (await pagina.context().cookies()).filter((c) => c.name === COOKIE_SESION);
    expect(quedan.map((c) => c.path)).toEqual(['/']);
    expect(quedan[0].value).toBe(victima.sesion);
  });

  test('una sesión del atacante plantada por el curso no hace operar en su cuenta', async ({ nucleo, paginaComo }) => {
    const victima = await sesion(nucleo, ALUMNO_AUSTRAL);
    const atacante = await sesion(nucleo, ALUMNA2_AUSTRAL);
    const pagina = await paginaComo(victima);
    await pagina.goto(nucleo.url(`${id}-curso`, '/'));
    await pagina.evaluate(
      ([d, t]) => {
        document.cookie = `campusia_sesion=${t}; Domain=${d}; Path=/api`;
      },
      [DOMINIO, atacante.sesion!],
    );
    await pagina.goto(nucleo.url(undefined, '/'));
    const vistos: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await pagina.evaluate(async () => {
        const res = await fetch('/api/yo');
        return { estado: res.status, cuerpo: await res.text() };
      });
      vistos.push(r.cuerpo);
      expect(r.cuerpo).not.toContain(ALUMNA2_AUSTRAL);
    }
    expect(vistos[vistos.length - 1]).toContain(ALUMNO_AUSTRAL);
    const quedan = (await pagina.context().cookies()).filter((c) => c.name === COOKIE_SESION);
    expect(quedan.map((c) => c.value)).toEqual([victima.sesion]);
  });
});
