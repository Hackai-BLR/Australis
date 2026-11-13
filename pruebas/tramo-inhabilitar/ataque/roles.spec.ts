import { crearTestTramo, expect, ADMIN_AUSTRAL, ADMIN2_AUSTRAL, ADMIN_DEMO, ALUMNO_DEMO, OWNER, PROFE_AUSTRAL } from '../fixtures.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { aleatorio } from '../../comun/sesion.ts';
import {
  AUSTRAL,
  DEMO,
  cuentaNueva,
  cursoDePrueba,
  ejecutarSql,
  esperarOk,
  estadoCuenta,
  fila,
  idUniversidad,
  idUsuario,
  revivirSesiones,
  sesion,
  sesionReautenticada,
  tokenPersonal,
  universidadNueva,
} from '../lib.ts';
import { MODO_CODIGO } from '../../comun/nucleo.ts';

const test = crearTestTramo({ entorno: MODO_CODIGO });

function roles(nucleo: Nucleo, id: number) {
  const f = fila(nucleo, 'SELECT administrador, owner FROM usuarios WHERE id = ?', id);
  return { administrador: Number(f.administrador), owner: Number(f.owner) };
}

test.describe('roles de administrador y owner', () => {
  test('un administrador o una cuenta común no quita administradores ni da o quita owners', async ({ nucleo }) => {
    const austral = idUniversidad(nucleo, AUSTRAL);
    const radmin = idUsuario(nucleo, ADMIN2_AUSTRAL);
    const owner = idUsuario(nucleo, OWNER);
    const victima = await cuentaNueva(nucleo);
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const profe = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    const comun = await cuentaNueva(nucleo);
    const comunReaut = await sesionReautenticada(nucleo, comun.email);
    for (const c of [ana, profe, comunReaut]) {
      const intentos = [
        await c.delete(`/api/owner/universidades/${austral}/administradores/${radmin}`),
        await c.post('/api/owner/owners', { email: victima.email }),
        await c.post('/api/owner/owners', { email: `${aleatorio('x')}@equipo.campusia.prueba` }),
        await c.delete(`/api/owner/owners/${owner}`),
        await c.get('/api/owner/owners'),
      ];
      for (const r of intentos) {
        expect(r.status, r.texto).toBe(403);
        expect(r.json.error).toBe('prohibido');
      }
    }
    expect(roles(nucleo, radmin)).toEqual({ administrador: 1, owner: 0 });
    expect(roles(nucleo, victima.id).owner).toBe(0);
    expect(roles(nucleo, owner).owner).toBe(1);
  });

  test('las rutas de roles exigen sesión reautenticada y no aceptan tokens', async ({ nucleo }) => {
    const austral = idUniversidad(nucleo, AUSTRAL);
    const radmin = idUsuario(nucleo, ADMIN2_AUSTRAL);
    const victima = await cuentaNueva(nucleo);
    const sinReaut = await sesion(nucleo, OWNER);
    for (const r of [
      await sinReaut.delete(`/api/owner/universidades/${austral}/administradores/${radmin}`),
      await sinReaut.post('/api/owner/owners', { email: victima.email }),
      await sinReaut.delete(`/api/owner/owners/${idUsuario(nucleo, OWNER)}`),
    ]) {
      expect(r.status, r.texto).toBe(403);
      expect(r.json.error).toBe('reautenticacion_requerida');
    }
    const owner = await sesionReautenticada(nucleo, OWNER);
    const token = await tokenPersonal(owner, ['owner:leer', 'owner:escribir']);
    for (const r of [
      await owner.delete(`/api/owner/universidades/${austral}/administradores/${radmin}`, { bearer: token, sinCookies: true }),
      await owner.post('/api/owner/owners', { email: victima.email }, { bearer: token, sinCookies: true }),
    ]) {
      expect(r.status, r.texto).toBe(401);
      expect(r.json.error).toBe('no_autenticado');
    }
    const sinOrigen = await owner.post('/api/owner/owners', { email: victima.email }, { origen: null });
    expect(sinOrigen.status).toBe(403);
    expect(roles(nucleo, radmin).administrador).toBe(1);
    expect(roles(nucleo, victima.id).owner).toBe(0);
  });

  test('quitar un administrador de otra universidad, inexistente o que no lo es responde 404', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const demo = idUniversidad(nucleo, DEMO);
    const austral = idUniversidad(nucleo, AUSTRAL);
    const radmin = idUsuario(nucleo, ADMIN2_AUSTRAL);
    for (const ruta of [
      `/api/owner/universidades/${demo}/administradores/${radmin}`,
      `/api/owner/universidades/${austral}/administradores/${idUsuario(nucleo, PROFE_AUSTRAL)}`,
      `/api/owner/universidades/999999/administradores/${radmin}`,
      `/api/owner/universidades/${austral}/administradores/abc`,
      `/api/owner/owners/${idUsuario(nucleo, PROFE_AUSTRAL)}`,
      '/api/owner/owners/999999',
    ]) {
      const r = await owner.delete(ruta);
      expect(r.status, `${ruta}: ${r.texto}`).toBe(404);
    }
    expect(roles(nucleo, radmin).administrador).toBe(1);
  });

  test('el último administrador no se quita aunque los otros estén suspendidos', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(owner);
    const segundo = `admin2@${uni.dominio}`;
    esperarOk(await owner.post(`/api/owner/universidades/${uni.id}/administradores`, { email: segundo }), 'invitar', 201);
    const idSegundo = idUsuario(nucleo, segundo);
    esperarOk(await owner.post(`/api/owner/personas/${idSegundo}/suspender`, {}), 'suspender al segundo');
    const r = await owner.delete(`/api/owner/universidades/${uni.id}/administradores/${idUsuario(nucleo, uni.admin)}`);
    expect(r.status, r.texto).toBe(409);
    expect(r.json.error).toBe('ultimo_administrador');
    expect(roles(nucleo, idUsuario(nucleo, uni.admin)).administrador).toBe(1);
  });

  test('las sesiones viejas de un administrador quitado no sirven, ni revividas en la base', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(owner);
    esperarOk(await owner.post(`/api/owner/universidades/${uni.id}/administradores`, { email: `admin2@${uni.dominio}` }), 'invitar', 201);
    const admin = await sesionReautenticada(nucleo, uni.admin);
    const victima = await cuentaNueva(nucleo, uni.dominio);
    esperarOk(await owner.delete(`/api/owner/universidades/${uni.id}/administradores/${idUsuario(nucleo, uni.admin)}`), 'quitar');
    expect((await admin.post(`/api/admin/personas/${victima.id}/suspender`, {})).status).toBe(401);
    revivirSesiones(nucleo, uni.admin);
    for (const r of [
      await admin.get('/api/admin/personas'),
      await admin.post(`/api/admin/personas/${victima.id}/suspender`, {}),
      await admin.post('/api/admin/invitaciones', { email: `otro@${uni.dominio}`, tipo: 'administrador' }),
    ]) {
      expect(r.status, r.texto).toBe(403);
    }
    expect(estadoCuenta(nucleo, victima.id).suspendida_en).toBeNull();
    expect(roles(nucleo, idUsuario(nucleo, uni.admin)).administrador).toBe(0);
  });

  test('las sesiones viejas de un owner quitado no sirven, ni revividas en la base', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const email = `${aleatorio('o')}@equipo.campusia.prueba`;
    esperarOk(await owner.post('/api/owner/owners', { email }), 'invitar owner', 201);
    const otro = await sesionReautenticada(nucleo, email);
    const token = await tokenPersonal(otro, ['owner:leer']);
    const id = idUsuario(nucleo, email);
    esperarOk(await owner.delete(`/api/owner/owners/${id}`), 'quitar owner');
    expect((await otro.get('/api/owner/universidades')).status).toBe(401);
    expect((await otro.get('/api/owner/universidades', { bearer: token, sinCookies: true })).status).toBe(401);
    revivirSesiones(nucleo, email);
    ejecutarSql(nucleo, 'UPDATE tokens_api SET revocado = 0 WHERE usuario_id = ?', id);
    expect((await otro.get('/api/owner/universidades', { bearer: token, sinCookies: true })).status).toBe(401);
    for (const r of [
      await otro.get('/api/owner/universidades'),
      await otro.post('/api/owner/owners', { email }),
      await otro.delete(`/api/owner/owners/${idUsuario(nucleo, OWNER)}`),
      await otro.get(`/api/admin/personas?universidad=${idUniversidad(nucleo, AUSTRAL)}`),
    ]) {
      expect(r.status, r.texto).toBe(403);
    }
    expect(roles(nucleo, id).owner).toBe(0);
    expect(roles(nucleo, idUsuario(nucleo, OWNER)).owner).toBe(1);
  });
});

test.describe('indicar la universidad en las rutas de administrador', () => {
  test('un administrador que indica otra universidad recibe 404 y no cambia nada', async ({ nucleo }) => {
    const austral = idUniversidad(nucleo, AUSTRAL);
    const demo = idUniversidad(nucleo, DEMO);
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const alumnoDemo = idUsuario(nucleo, ALUMNO_DEMO);
    const curso = cursoDePrueba(nucleo, { universidad: demo, dueno: 'profe@demo.edu.ar' });
    expect((await ana.get(`/api/admin/personas?universidad=${austral}`)).status).toBe(200);
    const intentos = [
      await ana.get(`/api/admin/personas?universidad=${demo}`),
      await ana.get(`/api/admin/universidad?universidad=${demo}`),
      await ana.get(`/api/admin/cursos?universidad=${demo}`),
      await ana.get(`/api/admin/auditoria?universidad=${demo}`),
      await ana.get('/api/admin/personas?universidad=abc'),
      await ana.get('/api/admin/personas?universidad=999999'),
      await ana.post(`/api/admin/personas/${alumnoDemo}/suspender?universidad=${demo}`, {}),
      await ana.put(`/api/admin/personas/${alumnoDemo}/profesor?universidad=${demo}`, { profesor: true }),
      await ana.post(`/api/admin/invitaciones?universidad=${demo}`, { email: `x${Date.now()}@demo.edu.ar`, tipo: 'administrador' }),
      await ana.post(`/api/admin/cursos/${curso}/archivar?universidad=${demo}`, {}),
      await ana.put(`/api/admin/limite?universidad=${demo}`, { limite_usd: 1 }),
      await ana.post(`/api/admin/dominios?universidad=${demo}`, { dominio: 'sub.demo.edu.ar' }),
    ];
    for (const r of intentos) {
      expect(r.status, r.texto).toBe(404);
      expect(r.json.error).toBe('no_encontrado');
    }
    expect(estadoCuenta(nucleo, alumnoDemo).suspendida_en).toBeNull();
    expect(Number(fila(nucleo, 'SELECT profesor FROM usuarios WHERE id = ?', alumnoDemo).profesor)).toBe(0);
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeNull();
    expect(Number(fila(nucleo, 'SELECT limite_usd FROM universidades WHERE id = ?', demo).limite_usd)).not.toBe(1);
    expect(fila(nucleo, "SELECT COUNT(*) AS n FROM dominios WHERE dominio = 'sub.demo.edu.ar'").n).toBe(0);

    const demoAdmin = await sesionReautenticada(nucleo, ADMIN_DEMO);
    const r = await demoAdmin.get(`/api/admin/personas?universidad=${austral}`);
    expect(r.status).toBe(404);
  });

  test('una cuenta común o un profesor que indican una universidad reciben 403', async ({ nucleo }) => {
    const austral = idUniversidad(nucleo, AUSTRAL);
    const comun = await cuentaNueva(nucleo);
    const profe = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    const victima = await cuentaNueva(nucleo);
    for (const c of [comun.cliente, profe]) {
      for (const r of [
        await c.get(`/api/admin/personas?universidad=${austral}`),
        await c.get(`/api/admin/cursos?universidad=${austral}`),
        await c.post(`/api/admin/personas/${victima.id}/suspender?universidad=${austral}`, {}),
        await c.get('/api/admin/personas?universidad=999999'),
      ]) {
        expect(r.status, r.texto).toBe(403);
        expect(r.json.error).toBe('prohibido');
      }
    }
    expect(estadoCuenta(nucleo, victima.id).suspendida_en).toBeNull();
  });
});
