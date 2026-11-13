import { crearTestAcciones, expect, TIEMPO_FASE3, PROFE_AUSTRAL, ADMIN_AUSTRAL } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { inscribirOk } from '../../fase-2/lib/cursos.ts';
import { cursoConEspacio } from '../../fase-3/lib/agente.ts';
import { correrScript, idDe, ok, profesorNuevo, resultado, rolEnCurso, sesionDe } from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let duena: Cliente;
let admin: Cliente;
const confirmaciones: Record<string, number> = {};
let quitado = '';
let sinMarca = { email: '', id: 0 };
let heredero = { email: '', id: 0 };

function enBase(nucleo: any, cid: number) {
  return nucleo.consultar('SELECT * FROM confirmaciones_agente WHERE id = ?', cid)[0];
}

async function pendientes(c: Cliente, curso: string): Promise<number[]> {
  return (ok(await c.get(`/api/cursos/${curso}/confirmaciones`), 'confirmaciones').confirmaciones as any[]).map((x) => Number(x.id));
}

async function quedaFallida(nucleo: any, cid: number) {
  const f = enBase(nucleo, cid);
  expect(f.estado).toBe('fallida');
  expect(String(f.error ?? '').trim().length, 'la confirmación fallida tiene que guardar el motivo').toBeGreaterThan(0);
  expect(f.resuelta_en).toBeTruthy();
  expect(await pendientes(duena, id)).not.toContain(cid);
  const otra = await duena.post(`/api/cursos/${id}/confirmaciones/${cid}/aprobar`, {});
  expect(otra.status, otra.texto).toBe(409);
  expect(otra.json?.error).toBe('confirmacion_resuelta');
  const cancelar = await duena.post(`/api/cursos/${id}/confirmaciones/${cid}/rechazar`, {});
  expect(cancelar.status, cancelar.texto).toBe(409);
  expect(enBase(nucleo, cid).estado).toBe('fallida');
}

test.describe('una confirmación que ya no se puede ejecutar queda fallida', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    id = await cursoConEspacio(duena, { nombre: 'Curso con Pedidos Viejos' });
    quitado = `${aleatorio('fq.')}@mail.austral.edu.ar`;
    const a = await profesorNuevo(nucleo, admin);
    const b = await profesorNuevo(nucleo, admin);
    sinMarca = { email: a.email, id: a.id };
    heredero = { email: b.email, id: b.id };
    await inscribirOk(duena, id, [quitado, sinMarca.email]);
    await inscribirOk(duena, id, [heredero.email], 'profesor');
    const res = await correrScript(
      nucleo,
      duena,
      id,
      [
        `await intentar('quitar', () => c.pedirQuitar('${idDe(nucleo, quitado)}'));`,
        `await intentar('rol', () => c.pedirCambioDeRol('${sinMarca.id}', 'profesor'));`,
        `await intentar('dueno', () => c.pedirCambioDeRol('${heredero.id}', 'alumno'));`,
      ].join('\n'),
      { pedido: 'Ordená los roles del curso' },
    );
    for (const clave of ['quitar', 'rol', 'dueno']) {
      const r = resultado(res, clave);
      expect(r.ok, `${clave}: ${JSON.stringify(r)}`).toBe(true);
      expect(r.valor.estado).toBe('pendiente');
      confirmaciones[clave] = Number(r.valor.id);
    }
  });

  test('la persona que se pedía quitar ya no está: 404 y la confirmación queda fallida', async ({ nucleo }) => {
    const cid = confirmaciones.quitar!;
    const borrar = await duena.delete(`/api/cursos/${id}/inscriptos/${idDe(nucleo, quitado)}`);
    expect(borrar.status, borrar.texto).toBe(204);
    const r = await duena.post(`/api/cursos/${id}/confirmaciones/${cid}/aprobar`, {});
    expect(r.status, r.texto).toBe(404);
    await quedaFallida(nucleo, cid);
    expect(rolEnCurso(nucleo, id, quitado)).toBeNull();
  });

  test('la persona perdió la marca de profesor: 400 no_es_profesor y la confirmación queda fallida', async ({ nucleo }) => {
    const cid = confirmaciones.rol!;
    ok(await admin.put(`/api/admin/personas/${sinMarca.id}/profesor`, { profesor: false }), 'quitar la marca');
    const r = await duena.post(`/api/cursos/${id}/confirmaciones/${cid}/aprobar`, {});
    expect(r.status, r.texto).toBe(400);
    expect(r.json?.error).toBe('no_es_profesor');
    await quedaFallida(nucleo, cid);
    expect(rolEnCurso(nucleo, id, sinMarca.email)).toBe('alumno');
  });

  test('la persona ahora es la dueña del curso: 409 es_dueno y la confirmación queda fallida', async ({ nucleo }) => {
    const cid = confirmaciones.dueno!;
    const t = await duena.post(`/api/cursos/${id}/transferir`, { usuario_id: heredero.id });
    expect([200, 204], t.texto).toContain(t.status);
    expect(rolEnCurso(nucleo, id, heredero.email)).toBe('dueño');
    const r = await duena.post(`/api/cursos/${id}/confirmaciones/${cid}/aprobar`, {});
    expect(r.status, r.texto).toBe(409);
    expect(r.json?.error).toBe('es_dueno');
    await quedaFallida(nucleo, cid);
    expect(rolEnCurso(nucleo, id, heredero.email)).toBe('dueño');
    expect(rolEnCurso(nucleo, id, PROFE_AUSTRAL)).toBe('profesor');
  });
});
