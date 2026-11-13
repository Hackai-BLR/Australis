import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { auditoria, enCurso, getCurso, inscribirOk, sesion } from '../../fase-2/lib/cursos.ts';
import { docker, corriendo, nombreContenedor } from '../../fase-2/lib/docker.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  ESPERA_RECARGA_MS,
  archivoEnRama,
  contenedorIdDe,
  cursoConEspacio,
  enPrueba,
  enPublicado,
  esperarRespuesta,
  git,
  guion,
  guionAgregarRuta,
  guionCambiarValor,
  lineaRuta,
  pedidoOk,
  publicarOk,
  volver,
} from '../lib/agente.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let profe: Cliente;
let profe2: Cliente;
let alumno: Cliente;

function valor(r: { status: number; json: any }) {
  return r.status === 200 ? r.json?.valor : undefined;
}

test.describe('pedir un cambio, verlo en prueba, publicar y volver', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    profe2 = await sesion(nucleo, PROFE2_AUSTRAL);
    alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso con Agente' });
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
  });

  test('el curso nuevo no tiene versiones ni cambios y la prueba muestra la plantilla', async () => {
    const c = await profe.get(`/api/cursos/${id}`);
    expect(c.status).toBe(200);
    expect(c.json.version_publicada).toBeNull();
    expect(c.json.cambios_sin_publicar).toBe(false);
    expect(c.json.espacio).toBe('encendido');
    const v = await profe.get(`/api/cursos/${id}/versiones`);
    expect(v.status).toBe(200);
    expect(v.json).toEqual({ publicada: null, cambios_sin_publicar: false, versiones: [] });
    const a = await profe.get(`/api/cursos/${id}/agente`);
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ mensajes: [], en_curso: false });
    const salud = await esperarRespuesta(() => enPrueba(profe, id, '/salud'), (r) => r.status === 200, ESPERA_RECARGA_MS, 'la prueba responde /salud');
    expect(salud.json).toEqual({ estado: 'ok' });
    const yo = await enPrueba(profe, id, '/api/yo');
    expect(yo.status).toBe(200);
    expect(yo.json.rol).toBe('dueño');
  });

  test('el profesor pide un cambio, lo sigue en vivo y lo ve en prueba pero no publicado', async ({ nucleo }) => {
    guion(nucleo, 'saludo', guionAgregarRuta('/saludo', 'UNO', 'Agregué la ruta de saludo.'));
    const antes = nucleo.modelo.pedidos.length;
    const { respuesta, r } = await pedidoOk(profe, id, 'Agregá una ruta de saludo [guion:saludo]');
    const nombres = r.eventos.map((e) => e.evento);
    expect(nombres[0]).toBe('inicio');
    expect(nombres[nombres.length - 1]).toBe('fin');
    const inicio = r.eventos[0]!.datos;
    expect(inicio.pedido.rol).toBe('profesor');
    expect(inicio.pedido.texto).toContain('Agregá una ruta de saludo');
    expect(inicio.pedido.autor.email).toBe(PROFE_AUSTRAL);
    expect(inicio.respuesta.rol).toBe('agente');
    expect(inicio.respuesta.estado).toBe('en_curso');
    const textos = r.eventos.filter((e) => e.evento === 'texto').map((e) => e.datos.texto).join('');
    expect(textos).toContain('Miro el servidor.');
    const herramientas = r.eventos.filter((e) => e.evento === 'herramienta').map((e) => e.datos);
    expect(herramientas.map((h) => h.nombre)).toEqual(expect.arrayContaining(['Read', 'Edit']));
    expect(herramientas.find((h) => h.nombre === 'Edit')?.ruta).toBe('servidor/app.ts');
    expect(respuesta.id).toBe(inicio.respuesta.id);
    expect(respuesta.texto).toContain('Agregué la ruta de saludo.');
    expect(respuesta.archivos).toEqual([{ ruta: 'servidor/app.ts', cambio: 'modificado' }]);
    expect(nucleo.modelo.pedidos.length - antes).toBeGreaterThanOrEqual(3);

    expect(archivoEnRama(nucleo, id, 'prueba', 'servidor/app.ts')).toContain(lineaRuta('/saludo', 'UNO'));
    expect(archivoEnRama(nucleo, id, 'main', 'servidor/app.ts')).not.toContain(lineaRuta('/saludo', 'UNO'));
    expect(Number(git(nucleo, id, ['rev-list', '--count', 'main..prueba']).salida)).toBeGreaterThanOrEqual(1);
    expect(git(nucleo, id, ['tag', '-l', 'v*']).salida).toBe('');

    await esperarRespuesta(() => enPrueba(profe, id, '/saludo'), (x) => valor(x) === 'UNO', ESPERA_RECARGA_MS, 'la prueba muestra el cambio');
    expect(valor(await enPublicado(profe, id, '/saludo'))).not.toBe('UNO');

    const c = await profe.get(`/api/cursos/${id}`);
    expect(c.json.cambios_sin_publicar).toBe(true);
    expect(c.json.version_publicada).toBeNull();
    const v = await profe.get(`/api/cursos/${id}/versiones`);
    expect(v.json.cambios_sin_publicar).toBe(true);

    const eventos = auditoria(nucleo, 'agente_pedido');
    expect(eventos.some((e) => e.detalle.includes(id) && e.detalle.includes(PROFE_AUSTRAL))).toBe(true);
  });

  test('la conversación queda guardada por curso y la ven todos sus docentes', async () => {
    const a = await profe2.get(`/api/cursos/${id}/agente`);
    expect(a.status).toBe(200);
    expect(a.json.en_curso).toBe(false);
    expect(a.json.mensajes).toHaveLength(2);
    const [pedido, respuesta] = a.json.mensajes;
    expect(pedido.rol).toBe('profesor');
    expect(pedido.autor.email).toBe(PROFE_AUSTRAL);
    expect(pedido.texto).toContain('Agregá una ruta de saludo');
    expect(pedido.archivos).toEqual([]);
    expect(respuesta.rol).toBe('agente');
    expect(respuesta.autor).toBeNull();
    expect(respuesta.estado).toBe('ok');
    expect(respuesta.archivos).toEqual([{ ruta: 'servidor/app.ts', cambio: 'modificado' }]);
    expect(typeof respuesta.fecha).toBe('string');
    expect(respuesta.id).toBeGreaterThan(pedido.id);
  });

  test('publicar corre la verificación, etiqueta v1, mueve main y cambia el tráfico', async ({ nucleo }) => {
    const nombre = nombreContenedor(nucleo.prefijo, id);
    const antes = contenedorIdDe(nombre);
    expect(antes).toBeTruthy();
    const datos = await enCurso(profe, id, 'POST', '/api/clases', { titulo: 'Clase que tiene que quedar', fecha: '2026-09-15' });
    expect(datos.status, datos.texto).toBe(201);

    const p = await publicarOk(profe, id);
    expect(p.tipo).toBe('publicar');
    expect(p.version).toBe(1);
    expect(p.etapa).toBe('listo');
    expect(p.descripcion).toContain('Agregá una ruta de saludo');
    expect(p.autor.nombre).toBeTruthy();
    expect(p.terminada).toBeTruthy();

    const r = await esperarRespuesta(() => enPublicado(profe, id, '/saludo'), (x) => valor(x) === 'UNO', 30_000, 'el curso publicado muestra el cambio');
    expect(valor(r)).toBe('UNO');
    expect(valor(await enPublicado(alumno, id, '/saludo'))).toBe('UNO');

    const clases = await getCurso(alumno, id, '/api/clases');
    expect(clases.json.map((x: any) => x.titulo)).toContain('Clase que tiene que quedar');

    expect(corriendo(nombre)).toBe(true);
    expect(contenedorIdDe(nombre)).not.toBe(antes);
    const delCurso = docker(['ps', '-a', '--filter', `label=campusia.prefijo=${nucleo.prefijo}`, '--filter', `label=campusia.curso=${id}`, '--format', '{{.Names}}'], true)
      .salida.split('\n')
      .filter((x) => x && !x.includes('-espacio-'));
    expect(delCurso).toEqual([nombre]);

    const main = git(nucleo, id, ['rev-parse', 'main']).salida;
    expect(git(nucleo, id, ['rev-parse', 'v1^{commit}']).salida).toBe(main);
    expect(git(nucleo, id, ['rev-parse', 'prueba']).salida).toBe(main);
    expect(git(nucleo, id, ['cat-file', '-t', 'v1']).salida).toBe('tag');
    expect(git(nucleo, id, ['status', '--porcelain']).salida).toBe('');
    expect(git(nucleo, id, ['rev-parse', '--abbrev-ref', 'HEAD']).salida).toBe('main');

    const c = await profe.get(`/api/cursos/${id}`);
    expect(c.json.version_publicada).toBe(1);
    expect(c.json.cambios_sin_publicar).toBe(false);
    const v = await profe.get(`/api/cursos/${id}/versiones`);
    expect(v.json.publicada).toBe(1);
    expect(v.json.cambios_sin_publicar).toBe(false);
    expect(v.json.versiones).toHaveLength(1);
    expect(v.json.versiones[0]).toMatchObject({ numero: 1, commit: main, origen: null });
    expect(v.json.versiones[0].descripcion).toContain('Agregá una ruta de saludo');

    const otra = await profe.post(`/api/cursos/${id}/publicar`, {});
    expect(otra.status).toBe(409);
    expect(otra.json.error).toBe('sin_cambios');

    const lista = await profe.get(`/api/cursos/${id}/publicaciones`);
    expect(lista.status).toBe(200);
    expect(lista.json.publicaciones[0].id).toBe(p.id);

    expect(auditoria(nucleo, 'publicacion').some((e) => e.detalle.includes(id) && e.detalle.includes('1'))).toBe(true);
  });

  test('un profesor del curso pide otro cambio y lo publica como v2 con su descripción', async ({ nucleo }) => {
    guion(nucleo, 'dos', guionCambiarValor('/saludo', 'UNO', 'DOS'));
    const { respuesta } = await pedidoOk(profe2, id, 'Cambiá el saludo [guion:dos]');
    expect(respuesta.archivos).toEqual([{ ruta: 'servidor/app.ts', cambio: 'modificado' }]);
    await esperarRespuesta(() => enPrueba(profe2, id, '/saludo'), (x) => valor(x) === 'DOS', ESPERA_RECARGA_MS, 'la prueba muestra DOS');
    expect(valor(await enPublicado(alumno, id, '/saludo'))).toBe('UNO');
    const p = await publicarOk(profe2, id, { descripcion: 'Saludo nuevo', version: 99 });
    expect(p.version).toBe(2);
    expect(p.descripcion).toBe('Saludo nuevo');
    await esperarRespuesta(() => enPublicado(alumno, id, '/saludo'), (x) => valor(x) === 'DOS', 30_000, 'publicado muestra DOS');
    const v = await profe.get(`/api/cursos/${id}/versiones`);
    expect(v.json.versiones.map((x: any) => x.numero)).toEqual([2, 1]);
    expect(v.json.versiones[0].descripcion).toBe('Saludo nuevo');
    expect(v.json.versiones[0].autor.nombre).toBe('Diego Herrera');
    const clases = await getCurso(alumno, id, '/api/clases');
    expect(clases.json.map((x: any) => x.titulo)).toContain('Clase que tiene que quedar');
  });

  test('volver a la v1 la publica como v3 y la prueba queda igual a lo publicado', async ({ nucleo }) => {
    const p = await volver(profe, id, 1);
    expect(p.estado, `${p.etapa}: ${p.error}`).toBe('ok');
    expect(p.tipo).toBe('volver');
    expect(p.version).toBe(3);
    expect(p.desde_version).toBe(1);
    await esperarRespuesta(() => enPublicado(alumno, id, '/saludo'), (x) => valor(x) === 'UNO', 30_000, 'publicado vuelve a UNO');

    const v = await profe.get(`/api/cursos/${id}/versiones`);
    expect(v.json.publicada).toBe(3);
    expect(v.json.cambios_sin_publicar).toBe(false);
    expect(v.json.versiones.map((x: any) => x.numero)).toEqual([3, 2, 1]);
    expect(v.json.versiones[0]).toMatchObject({ numero: 3, origen: 1, descripcion: 'Vuelta a la v1' });

    expect(git(nucleo, id, ['rev-parse', 'v3^{tree}']).salida).toBe(git(nucleo, id, ['rev-parse', 'v1^{tree}']).salida);
    expect(git(nucleo, id, ['rev-parse', 'v3^{commit}']).salida).toBe(git(nucleo, id, ['rev-parse', 'main']).salida);
    expect(git(nucleo, id, ['rev-parse', 'prueba']).salida).toBe(git(nucleo, id, ['rev-parse', 'main']).salida);
    expect(git(nucleo, id, ['merge-base', '--is-ancestor', 'v2', 'main']).estado).toBe(0);

    await esperarRespuesta(() => enPrueba(profe, id, '/saludo'), (x) => valor(x) === 'UNO', ESPERA_RECARGA_MS, 'la prueba también vuelve a UNO');
    const c = await profe.get(`/api/cursos/${id}`);
    expect(c.json.version_publicada).toBe(3);

    const misma = await profe.post(`/api/cursos/${id}/versiones/3/volver`, {});
    expect(misma.status).toBe(409);
    expect(misma.json.error).toBe('es_la_publicada');
    const nada = await profe.post(`/api/cursos/${id}/versiones/99/volver`, {});
    expect(nada.status).toBe(404);
    expect(auditoria(nucleo, 'version_restaurada').some((e) => e.detalle.includes(id))).toBe(true);
  });

  test('Mis cursos y el panel de administrador muestran la versión publicada', async ({ nucleo }) => {
    const mis = await alumno.get('/api/mis-cursos');
    const este = (mis.json.cursos ?? mis.json).find((x: any) => x.id === id);
    expect(este?.version_publicada).toBe(3);
    const admin = await sesion(nucleo, 'ana.morales@austral.edu.ar');
    const cursos = await admin.get('/api/admin/cursos');
    expect(cursos.json.cursos.find((x: any) => x.id === id)?.version_publicada).toBe(3);
  });
});
