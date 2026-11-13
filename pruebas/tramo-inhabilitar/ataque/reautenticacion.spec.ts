import { crearTestTramo, expect, ADMIN_AUSTRAL, OWNER, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import {
  AUSTRAL,
  cuentaNueva,
  cursoDePrueba,
  fila,
  idUniversidad,
  idUsuario,
  sesion,
  sesionReautenticada,
  suspender,
  tokenPersonal,
  universidadNueva,
} from '../lib.ts';
import { MODO_CODIGO } from '../../comun/nucleo.ts';

const test = crearTestTramo({ entorno: MODO_CODIGO });

interface Caso {
  nombre: string;
  ruta: string;
  cuerpo: any;
}

function fotografia(nucleo: Nucleo) {
  return JSON.stringify({
    usuarios: nucleo.consultar('SELECT id, suspendida_en, baja_en FROM usuarios ORDER BY id'),
    universidades: nucleo.consultar('SELECT id, deshabilitada_en FROM universidades ORDER BY id'),
    cursos: nucleo.consultar('SELECT id, archivado_en FROM cursos ORDER BY id'),
    inscripciones: nucleo.consultar('SELECT curso_id, usuario_id, rol FROM inscripciones ORDER BY curso_id, usuario_id'),
  });
}

async function probar(nucleo: Nucleo, sinReaut: Cliente, conReaut: Cliente, token: string, casos: Caso[]) {
  for (const caso of casos) {
    const antes = fotografia(nucleo);
    const r1 = await sinReaut.post(caso.ruta, caso.cuerpo);
    expect(r1.status, `${caso.nombre} sin reautenticación: ${r1.texto}`).toBe(403);
    expect(r1.json.error).toBe('reautenticacion_requerida');
    const r2 = await sinReaut.post(caso.ruta, caso.cuerpo, { bearer: token, sinCookies: true });
    expect(r2.status, `${caso.nombre} con token: ${r2.texto}`).toBe(401);
    expect(r2.json.error).toBe('no_autenticado');
    const r3 = await conReaut.post(caso.ruta, caso.cuerpo, { origen: null });
    expect(r3.status, `${caso.nombre} sin Origin: ${r3.texto}`).toBe(403);
    expect(r3.json.error).toBe('origen_invalido');
    const r4 = await conReaut.post(caso.ruta, caso.cuerpo, { sinEncabezadoPropio: true });
    expect(r4.status, `${caso.nombre} sin X-Campusia: ${r4.texto}`).toBe(403);
    expect(r4.json.error).toBe('origen_invalido');
    const r5 = await conReaut.post(caso.ruta, caso.cuerpo, { origen: `${nucleo.esquema()}://redes-curso.campusia.prueba:${nucleo.puerto}` });
    expect(r5.status, `${caso.nombre} desde un curso: ${r5.texto}`).toBe(403);
    expect(fotografia(nucleo), `${caso.nombre} no cambia nada`).toBe(antes);
  }
}

test('acciones del administrador sin reautenticación, con token o desde otro origen', async ({ nucleo }) => {
  const conReaut = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
  const sinReaut = await sesion(nucleo, ADMIN_AUSTRAL);
  const token = await tokenPersonal(conReaut, ['admin:leer', 'admin:escribir', 'cursos:escribir']);
  const persona = await cuentaNueva(nucleo);
  const suspendida = await cuentaNueva(nucleo);
  expect((await suspender(conReaut, suspendida.id)).status).toBe(200);
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL });
  await probar(nucleo, sinReaut, conReaut, token, [
    { nombre: 'suspender', ruta: `/api/admin/personas/${persona.id}/suspender`, cuerpo: {} },
    { nombre: 'reactivar', ruta: `/api/admin/personas/${suspendida.id}/reactivar`, cuerpo: {} },
    { nombre: 'baja', ruta: `/api/admin/personas/${persona.id}/baja`, cuerpo: { confirmar: true } },
    { nombre: 'archivar', ruta: `/api/admin/cursos/${curso}/archivar`, cuerpo: {} },
    { nombre: 'transferir', ruta: `/api/admin/cursos/${curso}/transferir`, cuerpo: { usuario_id: idUsuario(nucleo, PROFE2_AUSTRAL) } },
  ]);
});

test('acciones del owner sin reautenticación, con token o desde otro origen', async ({ nucleo }) => {
  const conReaut = await sesionReautenticada(nucleo, OWNER);
  const sinReaut = await sesion(nucleo, OWNER);
  const token = await tokenPersonal(conReaut, ['owner:leer', 'owner:escribir']);
  const uni = await universidadNueva(conReaut);
  const persona = await cuentaNueva(nucleo);
  await probar(nucleo, sinReaut, conReaut, token, [
    { nombre: 'deshabilitar', ruta: `/api/owner/universidades/${uni.id}/deshabilitar`, cuerpo: {} },
    { nombre: 'suspender', ruta: `/api/owner/personas/${persona.id}/suspender`, cuerpo: {} },
    { nombre: 'baja', ruta: `/api/owner/personas/${persona.id}/baja`, cuerpo: { confirmar: true } },
  ]);
  expect((await conReaut.post(`/api/owner/universidades/${uni.id}/deshabilitar`, {})).status).toBe(200);
  await probar(nucleo, sinReaut, conReaut, token, [{ nombre: 'rehabilitar', ruta: `/api/owner/universidades/${uni.id}/rehabilitar`, cuerpo: {} }]);
  expect((await conReaut.post(`/api/owner/universidades/${uni.id}/rehabilitar`, {})).status).toBe(200);
});

test('archivar y desarchivar por el dueño sin reautenticación, con token o desde otro origen', async ({ nucleo }) => {
  const conReaut = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const sinReaut = await sesion(nucleo, PROFE_AUSTRAL);
  const token = await tokenPersonal(conReaut, ['cursos:leer', 'cursos:escribir']);
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL });
  await probar(nucleo, sinReaut, conReaut, token, [{ nombre: 'archivar', ruta: `/api/cursos/${curso}/archivar`, cuerpo: {} }]);
  expect((await conReaut.post(`/api/cursos/${curso}/archivar`, {})).status).toBe(200);
  await probar(nucleo, sinReaut, conReaut, token, [{ nombre: 'desarchivar', ruta: `/api/cursos/${curso}/desarchivar`, cuerpo: {} }]);
  expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeTruthy();
});
