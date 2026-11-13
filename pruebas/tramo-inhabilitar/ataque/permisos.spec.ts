import {
  crearTestTramo,
  expect,
  ADMIN_AUSTRAL,
  ADMIN2_AUSTRAL,
  ADMIN_DEMO,
  ALUMNO_AUSTRAL,
  OWNER,
  OWNER_AUSTRAL,
  PROFE_AUSTRAL,
  PROFE2_AUSTRAL,
  PROFE_DEMO,
  SIN_MARCA_AUSTRAL,
} from '../fixtures.ts';
import {
  AUSTRAL,
  DEMO,
  archivar,
  cuentaNueva,
  cursoDePrueba,
  darDeBaja,
  desarchivar,
  deshabilitar,
  estadoCuenta,
  fila,
  idUniversidad,
  idUsuario,
  profesorNuevo,
  reactivar,
  rehabilitar,
  sesionReautenticada,
  suspender,
} from '../lib.ts';
import { reautenticar } from '../../comun/sesion.ts';

const test = crearTestTramo();

function sinCambios(nucleo: any, id: number) {
  const e = estadoCuenta(nucleo, id);
  expect(e.suspendida_en).toBeNull();
  expect(e.baja_en).toBeNull();
}

test.describe('administrador sobre cuentas', () => {
  test('un administrador no toca personas de otra universidad', async ({ nucleo }) => {
    const demo = await sesionReautenticada(nucleo, ADMIN_DEMO);
    const victima = await cuentaNueva(nucleo);
    for (const r of [await suspender(demo, victima.id), await reactivar(demo, victima.id), await darDeBaja(demo, victima.id)]) {
      expect(r.status, r.texto).toBe(404);
      expect(r.json.error).toBe('no_encontrado');
      expect(r.texto).not.toContain(victima.email);
    }
    sinCambios(nucleo, victima.id);
    expect((await victima.cliente.get('/api/yo')).status).toBe(200);
    expect((await suspender(demo, 999999)).status).toBe(404);
  });

  test('un administrador no suspende a un owner, a otro administrador ni a sí mismo', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const rectora = idUsuario(nucleo, OWNER_AUSTRAL);
    const raul = idUsuario(nucleo, ADMIN2_AUSTRAL);
    const propia = idUsuario(nucleo, ADMIN_AUSTRAL);
    const owner = idUsuario(nucleo, OWNER);
    for (const id of [rectora, raul]) {
      for (const r of [await suspender(ana, id), await darDeBaja(ana, id), await reactivar(ana, id)]) {
        expect(r.status, r.texto).toBe(403);
        expect(r.json.error).toBe('prohibido');
      }
      sinCambios(nucleo, id);
    }
    for (const r of [await suspender(ana, propia), await darDeBaja(ana, propia)]) {
      expect(r.status, r.texto).toBe(409);
      expect(r.json.error).toBe('propia_cuenta');
    }
    sinCambios(nucleo, propia);
    expect((await suspender(ana, owner)).status).toBe(404);
    sinCambios(nucleo, owner);
    expect((await ana.get('/api/yo')).status).toBe(200);
  });

  test('el owner no se suspende a sí mismo', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const id = idUsuario(nucleo, OWNER);
    for (const r of [await suspender(owner, id, 'owner'), await darDeBaja(owner, id, 'owner')]) {
      expect(r.status, r.texto).toBe(409);
      expect(r.json.error).toBe('propia_cuenta');
    }
    sinCambios(nucleo, id);
    expect((await owner.get('/api/yo')).status).toBe(200);
  });

  test('quien no es administrador u owner no usa esas rutas', async ({ nucleo }) => {
    const victima = await cuentaNueva(nucleo);
    for (const email of [PROFE_AUSTRAL, ALUMNO_AUSTRAL, SIN_MARCA_AUSTRAL]) {
      const c = await sesionReautenticada(nucleo, email);
      for (const como of ['admin', 'owner'] as const) {
        for (const r of [await suspender(c, victima.id, como), await reactivar(c, victima.id, como), await darDeBaja(c, victima.id, como)]) {
          expect(r.status, `${email} ${como}: ${r.texto}`).toBe(403);
          expect(r.json.error).toBe('prohibido');
        }
      }
      expect((await deshabilitar(c, idUniversidad(nucleo, AUSTRAL))).status).toBe(403);
    }
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    for (const r of [await suspender(ana, victima.id, 'owner'), await deshabilitar(ana, idUniversidad(nucleo, AUSTRAL)), await rehabilitar(ana, idUniversidad(nucleo, AUSTRAL))]) {
      expect(r.status, r.texto).toBe(403);
      expect(r.json.error).toBe('prohibido');
    }
    const owner = await sesionReautenticada(nucleo, OWNER);
    for (const r of [await suspender(owner, victima.id, 'admin'), await archivar(owner, 'redes', 'admin')]) {
      expect(r.status, r.texto).toBe(403);
      expect(r.json.error).toBe('prohibido');
    }
    sinCambios(nucleo, victima.id);
    expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', idUniversidad(nucleo, AUSTRAL)).deshabilitada_en).toBeNull();
    expect(fila(nucleo, "SELECT archivado_en FROM cursos WHERE id = 'redes'").archivado_en).toBeNull();
  });

  test('el estado y el destino nunca salen del cuerpo', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const a = await cuentaNueva(nucleo);
    const b = await cuentaNueva(nucleo);
    const r = await ana.post(`/api/admin/personas/${a.id}/suspender`, { id: b.id, usuario_id: b.id, email: b.email });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.id).toBe(a.id);
    sinCambios(nucleo, b.id);
    const marca = await ana.put(`/api/admin/personas/${a.id}/profesor`, { profesor: false, estado: 'activa', suspendida: false, suspendida_en: null });
    expect([200, 401, 403, 404]).toContain(marca.status);
    expect(estadoCuenta(nucleo, a.id).suspendida_en).toBeTruthy();
    expect((await a.cliente.get('/api/yo')).status).toBe(401);

    const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL });
    expect((await archivar(dueno, curso)).status).toBe(200);
    const cod = await dueno.put(`/api/cursos/${curso}/codigo`, { activo: true, archivado: false });
    expect(cod.status).toBe(409);
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeTruthy();
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = idUniversidad(nucleo, DEMO);
    const nueva = await owner.post('/api/owner/universidades', { nombre: `Universidad ${a.id}x`, dominio: `x${a.id}${Date.now().toString(36)}.edu.ar`, email_administrador: `admin@x${a.id}${Date.now().toString(36)}.edu.ar`, deshabilitada: true });
    if (nueva.status === 201) expect(nueva.json.deshabilitada).toBe(false);
    expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni).deshabilitada_en).toBeNull();
  });
});

test.describe('archivar cursos', () => {
  test('profesor no dueño, alumno, no inscripto, otro administrador y owner no archivan', async ({ nucleo }) => {
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL], alumnos: [alumno.email] });
    const profe = await sesionReautenticada(nucleo, PROFE2_AUSTRAL);
    await reautenticar(alumno.cliente);
    for (const c of [profe, alumno.cliente]) {
      for (const r of [await archivar(c, curso), await desarchivar(c, curso)]) {
        expect(r.status, r.texto).toBe(403);
        expect(r.json.error).toBe('prohibido');
      }
      expect((await archivar(c, curso, 'admin')).status).toBe(403);
    }
    for (const email of [SIN_MARCA_AUSTRAL, ADMIN_AUSTRAL, OWNER, ADMIN_DEMO]) {
      const c = await sesionReautenticada(nucleo, email);
      const r = await archivar(c, curso);
      expect(r.status, `${email}: ${r.texto}`).toBe(404);
      expect(r.json.error).toBe('no_encontrado');
    }
    const demo = await sesionReautenticada(nucleo, ADMIN_DEMO);
    for (const r of [await archivar(demo, curso, 'admin'), await desarchivar(demo, curso, 'admin'), await archivar(demo, 'redes', 'admin')]) {
      expect(r.status, r.texto).toBe(404);
      expect(r.json.error).toBe('no_encontrado');
    }
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    expect((await archivar(ana, 'quimica', 'admin')).status).toBe(404);
    expect((await archivar(ana, 'no-existe-nunca', 'admin')).status).toBe(404);
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeNull();
    expect(fila(nucleo, "SELECT archivado_en FROM cursos WHERE id = 'quimica'").archivado_en).toBeNull();
    expect((await alumno.cliente.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).toContain(curso);
  });

  test('un profesor no desarchiva lo que archivó el dueño', async ({ nucleo }) => {
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL] });
    const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    expect((await archivar(dueno, curso)).status).toBe(200);
    const profe = await sesionReautenticada(nucleo, PROFE2_AUSTRAL);
    const r = await desarchivar(profe, curso);
    expect(r.status).toBe(403);
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeTruthy();
  });
});

test.describe('transferencias del administrador', () => {
  test('solo a un profesor activo de la universidad, y solo cursos de su universidad', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const uni = idUniversidad(nucleo, AUSTRAL);
    const curso = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE_AUSTRAL });
    const sinMarca = await cuentaNueva(nucleo);
    const suspendido = await profesorNuevo(nucleo, ana);
    expect((await suspender(ana, suspendido.id)).status).toBe(200);

    const r1 = await ana.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: sinMarca.id });
    expect(r1.status, r1.texto).toBe(400);
    expect(r1.json.error).toBe('no_es_profesor');
    const r2 = await ana.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: suspendido.id });
    expect(r2.status, r2.texto).toBe(409);
    expect(r2.json.error).toBe('cuenta_suspendida');
    const r3 = await ana.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: idUsuario(nucleo, PROFE_DEMO) });
    expect(r3.status, r3.texto).toBe(404);
    const r4 = await ana.post('/api/admin/cursos/quimica/transferir', { usuario_id: idUsuario(nucleo, PROFE2_AUSTRAL) });
    expect(r4.status, r4.texto).toBe(404);

    const demo = await sesionReautenticada(nucleo, ADMIN_DEMO);
    const r5 = await demo.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: idUsuario(nucleo, PROFE_DEMO) });
    expect(r5.status, r5.texto).toBe(404);
    const profe = await sesionReautenticada(nucleo, PROFE2_AUSTRAL);
    const r6 = await profe.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: idUsuario(nucleo, PROFE2_AUSTRAL) });
    expect(r6.status, r6.texto).toBe(403);

    const roles = nucleo.consultar("SELECT usuario_id FROM inscripciones WHERE curso_id = ? AND rol = 'dueño'", curso);
    expect(roles.map((f: any) => Number(f.usuario_id))).toEqual([idUsuario(nucleo, PROFE_AUSTRAL)]);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ?', curso).n).toBe(1);
  });
});
