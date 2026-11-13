import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, ALUMNO_AUSTRAL, ADMIN_AUSTRAL, OWNER } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { reautenticar } from '../../comun/sesion.ts';
import { cursoListo, ejecutarSql, idUsuario, inscribirOk, sesion } from '../../fase-2/lib/cursos.ts';
import { ESPERA_RECARGA_MS, cursoConEspacio, enPrueba, esperarRespuesta, finDe, git, guion, guionBash, guionEscribir, pedirAlAgente } from '../lib/agente.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let a = '';
let profe: Cliente;

function rutas(id: string): Array<[string, string, any]> {
  return [
    ['GET', `/api/cursos/${id}/espacio`, undefined],
    ['POST', `/api/cursos/${id}/espacio`, {}],
    ['GET', `/api/cursos/${id}/agente`, undefined],
    ['POST', `/api/cursos/${id}/agente`, { pedido: 'Borrá todo [guion:prohibido]' }],
    ['GET', `/api/cursos/${id}/versiones`, undefined],
    ['POST', `/api/cursos/${id}/publicar`, {}],
    ['POST', `/api/cursos/${id}/versiones/1/volver`, {}],
    ['GET', `/api/cursos/${id}/publicaciones`, undefined],
    ['GET', `/api/cursos/${id}/publicaciones/1`, undefined],
    ['GET', `/api/cursos/${id}/uso`, undefined],
  ];
}

function nadaPaso(nucleo: any, id: string, pedidosAntes: number) {
  expect(nucleo.modelo.pedidos.length).toBe(pedidosAntes);
  expect(nucleo.consultar('SELECT COUNT(*) AS n FROM mensajes_agente WHERE curso_id = ?', id)[0].n).toBe(0);
  expect(nucleo.consultar('SELECT COUNT(*) AS n FROM publicaciones WHERE curso_id = ?', id)[0].n).toBe(0);
  expect(git(nucleo, id, ['tag', '-l']).salida).toBe('');
  expect(git(nucleo, id, ['rev-parse', 'prueba']).salida).toBe(git(nucleo, id, ['rev-parse', 'main']).salida);
}

test.describe('nadie fuera de los docentes del curso edita, publica ni ve la prueba', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    a = await cursoConEspacio(profe, { nombre: 'Curso Protegido' });
    await inscribirOk(profe, a, [ALUMNO_AUSTRAL]);
    const otro = await sesion(nucleo, PROFE2_AUSTRAL);
    await cursoListo(otro, { nombre: 'Curso de Otro Profesor' });
    guion(nucleo, 'prohibido', guionEscribir({ 'hackeado.txt': 'hackeado\n' }));
  });

  test('un alumno del curso recibe 403 en todas las rutas', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    for (const [m, r, c] of rutas(a)) {
      const res = await alumno.pedir(m, r, c);
      expect(res.status, `${m} ${r}`).toBe(403);
      expect(res.json?.error, `${m} ${r}`).toBe('prohibido');
    }
    nadaPaso(nucleo, a, antes);
  });

  test('profesores de otro curso, administradores y el owner reciben 404', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    for (const email of [PROFE2_AUSTRAL, ADMIN_AUSTRAL, OWNER]) {
      const c = await sesion(nucleo, email);
      for (const [m, r, b] of rutas(a)) {
        const res = await c.pedir(m, r, b);
        expect(res.status, `${email} ${m} ${r}`).toBe(404);
      }
    }
    const anon = new Cliente(nucleo);
    for (const [m, r, b] of rutas(a)) {
      const res = await anon.pedir(m, r, b);
      expect(res.status, `sin sesión ${m} ${r}`).toBe(401);
    }
    nadaPaso(nucleo, a, antes);
  });

  test('la versión de prueba solo la ven los docentes', async ({ nucleo }) => {
    await esperarRespuesta(() => enPrueba(profe, a, '/salud'), (r) => r.status === 200, ESPERA_RECARGA_MS, 'la prueba responde al dueño');
    for (const email of [ALUMNO_AUSTRAL, PROFE2_AUSTRAL, ADMIN_AUSTRAL, OWNER]) {
      const c = await sesion(nucleo, email);
      for (const ruta of ['/', '/salud', '/api/yo', '/api/clases']) {
        const r = await enPrueba(c, a, ruta);
        expect(r.status, `${email} ${ruta}`).toBe(403);
        expect(r.texto).not.toContain('Curso Protegido');
      }
      const post = await c.pedir('POST', '/api/clases', { titulo: 'Intrusa' }, { sub: `${a}-prueba` });
      expect(post.status, email).toBe(403);
    }
    const anon = new Cliente(nucleo);
    const r = await enPrueba(anon, a, '/');
    expect(r.status).toBe(401);
    expect(r.texto).not.toContain('Curso Protegido');
    expect(r.texto).toContain(`${a}.`);
    const conToken = new Cliente(nucleo);
    conToken.bearer = `cia_${'A'.repeat(43)}`;
    const t = await enPrueba(conToken, a, '/api/yo', { sinCookies: true });
    expect(t.status).toBe(401);
    const inexistente = await enPrueba(profe, 'no-existe-curso', '/');
    expect(inexistente.status).toBe(404);
    const sembrado = await enPrueba(await sesion(nucleo, PROFE_AUSTRAL), 'redes', '/');
    expect(sembrado.status).toBe(404);
    const clases = await enPrueba(profe, a, '/api/clases');
    expect(clases.json.map((x: any) => x.titulo)).not.toContain('Intrusa');
  });

  test('las modificaciones desde otro origen o sin el encabezado propio se rechazan', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const p = nucleo.puerto;
    const malos: Array<string | null> = [
      null,
      'null',
      `http://${a}-curso.campusia.prueba:${p}`,
      `http://${a}-prueba.campusia.prueba:${p}`,
      `http://evil.com:${p}`,
      `http://otro.campusia.prueba:${p}`,
    ];
    for (const origen of malos) {
      for (const ruta of [`/api/cursos/${a}/agente`, `/api/cursos/${a}/publicar`, `/api/cursos/${a}/espacio`, `/api/cursos/${a}/versiones/1/volver`]) {
        const r = await profe.post(ruta, { pedido: 'Borrá todo [guion:prohibido]' }, { origen });
        expect(r.status, `${origen} ${ruta}`).toBe(403);
        expect(r.json?.error).toBe('origen_invalido');
      }
    }
    const sinPropio = await pedirAlAgente(profe, a, 'Borrá todo [guion:prohibido]', { sinEncabezadoPropio: true });
    expect(sinPropio.status).toBe(403);
    const desdePrueba = await profe.pedir('POST', '/api/clases', { titulo: 'Desde el curso' }, { sub: `${a}-prueba`, origen: `http://${a}-curso.campusia.prueba:${p}` });
    expect(desdePrueba.status).toBe(403);
    nadaPaso(nucleo, a, antes);
  });

  test('un profesor quitado del curso pierde el acceso en la petición siguiente', async ({ nucleo }) => {
    await inscribirOk(profe, a, [PROFE3_AUSTRAL], 'profesor');
    const quitado = await sesion(nucleo, PROFE3_AUSTRAL);
    expect((await quitado.get(`/api/cursos/${a}/agente`)).status).toBe(200);
    await esperarRespuesta(() => enPrueba(quitado, a, '/salud'), (r) => r.status === 200, ESPERA_RECARGA_MS, 'el profesor ve la prueba');
    await reautenticar(profe);
    const q = await profe.delete(`/api/cursos/${a}/inscriptos/${idUsuario(nucleo, PROFE3_AUSTRAL)}`);
    expect(q.status).toBe(204);
    expect((await quitado.get(`/api/cursos/${a}/agente`)).status).toBe(404);
    expect((await quitado.post(`/api/cursos/${a}/agente`, { pedido: 'Hola [guion:prohibido]' })).status).toBe(404);
    expect((await enPrueba(quitado, a, '/salud')).status).toBe(403);
  });

  test('con el curso preparando o con error nada se enciende, ejecuta ni publica: 409 curso_no_listo antes que los conflictos', async ({ nucleo }) => {
    guion(nucleo, 'quieto', guionBash(['sleep 25']));
    const enCurso = pedirAlAgente(profe, a, 'Algo lento [guion:quieto]');
    await esperarRespuesta(() => profe.get(`/api/cursos/${a}/agente`), (r) => r.json?.en_curso === true, 120_000, 'el agente está trabajando');
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const contar = (tabla: string) => nucleo.consultar(`SELECT COUNT(*) AS n FROM ${tabla} WHERE curso_id = ?`, a)[0].n;
    try {
      for (const estado of ['preparando', 'error']) {
        ejecutarSql(nucleo, 'UPDATE cursos SET estado = ? WHERE id = ?', estado, a);
        const mensajes = contar('mensajes_agente');
        const publicaciones = contar('publicaciones');
        for (const [m, r, c] of rutas(a)) {
          const res = await profe.pedir(m, r, c);
          if (m === 'GET') {
            expect([200, 404], `${estado} ${m} ${r}`).toContain(res.status);
            if (!r.endsWith('/publicaciones/1')) expect(res.status, `${estado} ${m} ${r}`).toBe(200);
            continue;
          }
          expect(res.status, `${estado} ${m} ${r}: ${res.texto}`).toBe(409);
          expect(res.json?.error, `${estado} ${m} ${r}`).toBe('curso_no_listo');
          const deAlumno = await alumno.pedir(m, r, c);
          expect(deAlumno.status, `${estado} alumno ${m} ${r}`).toBe(403);
        }
        const vacio = await profe.post(`/api/cursos/${a}/agente`, { pedido: '   ' });
        expect(vacio.status).toBe(400);
        expect(vacio.json.error).toBe('datos_invalidos');
        const largo = await profe.post(`/api/cursos/${a}/publicar`, { descripcion: 'x'.repeat(201) });
        expect(largo.status).toBe(400);
        const prueba = await enPrueba(profe, a, '/salud');
        expect(prueba.status, estado).toBe(503);
        expect(contar('mensajes_agente')).toBe(mensajes);
        expect(contar('publicaciones')).toBe(publicaciones);
      }
    } finally {
      ejecutarSql(nucleo, "UPDATE cursos SET estado = 'listo' WHERE id = ?", a);
    }
    const r = await enCurso;
    expect(finDe(r)?.estado).toBe('ok');
    const libre = await profe.post(`/api/cursos/${a}/publicar`, {});
    expect(libre.status).toBe(409);
    expect(libre.json.error).toBe('sin_cambios');
  });
});

