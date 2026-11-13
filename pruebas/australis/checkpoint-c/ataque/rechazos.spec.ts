import { test, expect } from '@playwright/test';
import { entrar, origenDe, paginaDe, pedidosAlModelo, reiniciarModelo, type Sesion } from '../../comun/escenario-b.ts';
import { ADMIN_AUSTRAL, PROFE2_AUSTRAL, PROFE_AUSTRAL } from '../../comun/datos-b.ts';
import {
  alumnosDePrueba,
  crearCampusConAlumnos,
  crearClase,
  fijarAjusteGlobal,
  subirPdfPorPantalla,
  terminarClase,
  type Alumno,
  type CampusC,
} from '../../comun/escenario-c.ts';

test.describe.configure({ mode: 'serial' });

const ALUMNOS: Alumno[] = alumnosDePrueba(3);
const TITULO_CLASE = 'Clase de los rechazos';
const NOMBRE_CAMPUS_RECHAZOS = 'Campus de los rechazos de registros';

let profe: Sesion;
let profe2: Sesion;
let admin: Sesion;
let alumnaUno: Sesion;
let alumnaDos: Sesion;
let campus: CampusC;
let claseId = 0;
let alumnaUnoId = 0;

async function hoja() {
  const r = await profe.campus('GET', `/api/classes/${claseId}/attendance`);
  expect(r.estado, r.texto).toBe(200);
  return r.json;
}

test.beforeAll(async () => {
  profe = await entrar(PROFE_AUSTRAL);
  profe2 = await entrar(PROFE2_AUSTRAL);
  admin = await entrar(ADMIN_AUSTRAL);
  campus = await crearCampusConAlumnos(profe, NOMBRE_CAMPUS_RECHAZOS, ALUMNOS);
  claseId = await crearClase(profe, campus, TITULO_CLASE, 180, 60);
  await terminarClase(profe, claseId);
  alumnaUno = await entrar(ALUMNOS[0].correo);
  alumnaDos = await entrar(ALUMNOS[1].correo);
  const yo = await alumnaUno.campus('GET', `/api/classes/${claseId}/attendance`);
  expect(yo.estado, yo.texto).toBe(200);
  alumnaUnoId = yo.json.rows[0].user_id;
});

test.afterAll(async () => {
  fijarAjusteGlobal('ai.summary.daily_quota', '20');
});

test.describe('asistencia', () => {
  test('una alumna no puede tomar ni cambiar la asistencia, ni por la API ni por la pantalla', async ({ browser }) => {
    const tomada = await profe.campus('POST', `/api/classes/${claseId}/attendance/from-session`, {});
    expect(tomada.estado, tomada.texto).toBe(200);
    const antes = await hoja();

    const cambio = await alumnaUno.campus('PUT', `/api/classes/${claseId}/attendance`, {
      entries: [{ user_id: alumnaUnoId, status: 'present' }],
      reason: 'Quiero figurar presente',
    });
    expect(cambio.estado, cambio.texto).toBe(403);
    const deOtra = await alumnaUno.campus('PUT', `/api/classes/${claseId}/attendance`, {
      entries: antes.rows.map((f: any) => ({ user_id: f.user_id, status: 'present' })),
      reason: 'Todos presentes',
    });
    expect(deOtra.estado, deOtra.texto).toBe(403);
    const sesion = await alumnaUno.campus('POST', `/api/classes/${claseId}/attendance/from-session`, {});
    expect(sesion.estado, sesion.texto).toBe(403);
    expect(await hoja()).toEqual(antes);

    const { ctx, pagina } = await paginaDe(browser, alumnaUno);
    await pagina.goto(`${origenDe('campus')}/classes/${claseId}`);
    await expect(pagina.getByRole('heading', { name: 'Mi asistencia' })).toBeVisible();
    await expect(pagina.locator('select')).toHaveCount(0);
    await expect(pagina.getByRole('button', { name: 'Guardar asistencia' })).toHaveCount(0);
    await expect(pagina.getByRole('button', { name: 'Tomar de la sesión' })).toHaveCount(0);
    await ctx.close();
  });

  test('una persona de otro campus ni siquiera ve la asistencia', async () => {
    const otraUniversidad = await entrar('alumno@demo.edu.ar');
    const lectura = await otraUniversidad.campus('GET', `/api/classes/${claseId}/attendance`);
    expect([403, 404]).toContain(lectura.estado);
    const ajeno = await profe2.campus('PUT', `/api/classes/${claseId}/attendance`, {
      entries: [{ user_id: alumnaUnoId, status: 'excused' }],
      reason: 'No es mi campus',
    });
    expect([403, 404]).toContain(ajeno.estado);
  });

  test('corregir una asistencia ya guardada sin motivo se rechaza, y con un motivo vacío también', async ({ browser }) => {
    const antes = await hoja();
    const fila = antes.rows.find((f: any) => f.user_id === alumnaUnoId);
    const otro = fila.status === 'excused' ? 'absent' : 'excused';

    const sinMotivo = await profe.campus('PUT', `/api/classes/${claseId}/attendance`, { entries: [{ user_id: alumnaUnoId, status: otro }] });
    expect(sinMotivo.estado, sinMotivo.texto).toBe(422);
    const vacio = await profe.campus('PUT', `/api/classes/${claseId}/attendance`, { entries: [{ user_id: alumnaUnoId, status: otro }], reason: '   ' });
    expect(vacio.estado, vacio.texto).toBe(422);
    const intacta = (await hoja()).rows.find((f: any) => f.user_id === alumnaUnoId);
    expect(intacta.status).toBe(fila.status);

    const { ctx, pagina } = await paginaDe(browser, profe);
    await pagina.goto(`${origenDe('campus')}/classes/${claseId}`);
    await pagina.getByLabel(`Estado de ${ALUMNOS[0].nombre}`).selectOption(otro);
    await expect(pagina.getByRole('button', { name: 'Guardar asistencia' })).toBeDisabled();
    await pagina.getByLabel('Motivo del cambio').fill('   ');
    await expect(pagina.getByRole('button', { name: 'Guardar asistencia' })).toBeDisabled();
    await ctx.close();

    const conMotivo = await profe.campus('PUT', `/api/classes/${claseId}/attendance`, { entries: [{ user_id: alumnaUnoId, status: otro }], reason: 'Corrección verificada' });
    expect(conMotivo.estado, conMotivo.texto).toBe(200);
    const final = conMotivo.json.rows.find((f: any) => f.user_id === alumnaUnoId);
    expect(final.status).toBe(otro);
    expect(final.reason).toBe('Corrección verificada');
    const pisar = await profe.campus('POST', `/api/classes/${claseId}/attendance/from-session`, {});
    expect(pisar.estado, pisar.texto).toBe(422);
    const sigueCorregida = (await hoja()).rows.find((f: any) => f.user_id === alumnaUnoId);
    expect(sigueCorregida.status).toBe(otro);
  });
});

test.describe('resumen de la clase', () => {
  test('un resumen que no está aprobado no lo lee ninguna alumna, ni como borrador ni como texto editado', async () => {
    const secreto = 'BORRADOR-SIN-APROBAR-no-debe-salir';
    const generado = await profe.campus('POST', `/api/classes/${claseId}/summary/generate`, {});
    expect(generado.estado, generado.texto).toBe(200);
    expect(generado.json.status).toBe('draft');
    const editado = await profe.campus('PUT', `/api/classes/${claseId}/summary`, { body: secreto });
    expect(editado.estado, editado.texto).toBe(200);

    for (const alumna of [alumnaUno, alumnaDos]) {
      const r = await alumna.campus('GET', `/api/classes/${claseId}/summary`);
      expect(r.estado, r.texto).toBe(200);
      expect(r.json.status).toBe('none');
      expect(r.json.body).toBeNull();
      expect(r.texto).not.toContain(secreto);
    }

    const generarAlumna = await alumnaUno.campus('POST', `/api/classes/${claseId}/summary/generate`, {});
    expect(generarAlumna.estado, generarAlumna.texto).toBe(403);
    const aprobarAlumna = await alumnaUno.campus('POST', `/api/classes/${claseId}/summary/approve`, { body: secreto });
    expect(aprobarAlumna.estado, aprobarAlumna.texto).toBe(403);
    const editarAlumna = await alumnaUno.campus('PUT', `/api/classes/${claseId}/summary`, { body: 'Texto de una alumna' });
    expect(editarAlumna.estado, editarAlumna.texto).toBe(403);
    const sigue = await profe.campus('GET', `/api/classes/${claseId}/summary`);
    expect(sigue.json.body).toBe(secreto);
    expect(sigue.json.status).toBe('draft');
  });

  test('un resumen aprobado que se vuelve a editar deja de verse hasta que se aprueba otra vez', async () => {
    const aprobado = await profe.campus('POST', `/api/classes/${claseId}/summary/approve`, { body: 'BORRADOR-SIN-APROBAR-no-debe-salir' });
    expect(aprobado.estado, aprobado.texto).toBe(200);
    expect((await alumnaUno.campus('GET', `/api/classes/${claseId}/summary`)).json.status).toBe('approved');
    const reeditado = await profe.campus('PUT', `/api/classes/${claseId}/summary`, { body: 'Segunda versión sin aprobar' });
    expect(reeditado.estado, reeditado.texto).toBe(200);
    const oculto = await alumnaUno.campus('GET', `/api/classes/${claseId}/summary`);
    expect(oculto.json.status).toBe('none');
    expect(oculto.texto).not.toContain('Segunda versión');
  });
});

test.describe('notas por diapositiva', () => {
  test('una alumna no lee las notas de otra: ni por la lista, ni por la exportación, ni la profesora ni la secretaría', async ({ browser }) => {
    const subida = await subirPdfPorPantalla(browser, profe, campus, 'Presentación de los rechazos', 2);
    await subida.ctx.close();
    const pid = subida.presentacion;
    const privada = 'NOTA-PRIVADA-de-la-alumna-uno';
    const guardada = await alumnaUno.campus('PUT', `/api/presentations/${pid}/notes/1`, { body: privada });
    expect(guardada.estado, guardada.texto).toBe(200);

    const propia = await alumnaUno.campus('GET', `/api/presentations/${pid}/notes`);
    expect(propia.json.map((n: any) => n.body)).toEqual([privada]);

    for (const lector of [alumnaDos, profe, admin]) {
      const lista = await lector.campus('GET', `/api/presentations/${pid}/notes`);
      expect(lista.estado, lista.texto).toBe(200);
      expect(lista.json).toEqual([]);
      expect(lista.texto).not.toContain(privada);
      const exportada = await lector.campus('GET', `/api/presentations/${pid}/notes/export`);
      expect(exportada.estado, exportada.texto).toBe(200);
      expect(exportada.texto).not.toContain(privada);
    }

    const pisada = await alumnaDos.campus('PUT', `/api/presentations/${pid}/notes/1`, { body: 'Nota de la alumna dos' });
    expect(pisada.estado, pisada.texto).toBe(200);
    const intacta = await alumnaUno.campus('GET', `/api/presentations/${pid}/notes`);
    expect(intacta.json.map((n: any) => n.body)).toEqual([privada]);

    const fueraDeCampus = await entrar('alumno@demo.edu.ar');
    const ajena = await fueraDeCampus.campus('GET', `/api/presentations/${pid}/notes`);
    expect([403, 404]).toContain(ajena.estado);
    const ajenaExport = await fueraDeCampus.campus('GET', `/api/presentations/${pid}/notes/export`);
    expect([403, 404]).toContain(ajenaExport.estado);
    const ajenaEscribe = await fueraDeCampus.campus('PUT', `/api/presentations/${pid}/notes/1`, { body: 'intruso' });
    expect([403, 404]).toContain(ajenaEscribe.estado);
  });
});

test.describe('lista de todos los campus', () => {
  test('una profesora no abre la lista de todos los campus, ni por la API ni por la pantalla; una alumna tampoco', async ({ browser }) => {
    for (const sesion of [profe, profe2, alumnaUno]) {
      for (const ruta of ['/api/admin/campuses', '/api/admin/people', `/api/admin/people/${alumnaUnoId}`, '/api/grades/submissions']) {
        const r = await sesion.campus('GET', ruta);
        expect(r.estado, `${sesion.email ?? ''} ${ruta}: ${r.texto}`).toBe(403);
      }
    }
    const control = await admin.campus('GET', '/api/admin/campuses');
    expect(control.estado, control.texto).toBe(200);
    expect(control.json.map((c: any) => c.id)).toContain(campus.australis);

    const { ctx, pagina } = await paginaDe(browser, profe);
    await pagina.goto(`${origenDe('campus')}/`);
    await expect(pagina.getByRole('link', { name: 'Directorio' })).toHaveCount(0);
    await pagina.goto(`${origenDe('campus')}/admin/campuses`);
    await expect(pagina.getByRole('heading', { name: 'Todos los campus' })).toHaveCount(0);
    await expect(pagina.getByRole('link', { name: NOMBRE_CAMPUS_RECHAZOS })).toHaveCount(0);
    await ctx.close();
  });

  test('una profesora no marca las notas como verificadas ni las devuelve: eso es solo de la secretaría', async () => {
    const enviadas = await profe.campus('POST', `/api/campuses/${campus.australis}/grades/submission/send`, {});
    expect(enviadas.estado, enviadas.texto).toBe(200);
    const verificar = await profe.campus('POST', `/api/campuses/${campus.australis}/grades/submission/check`, {});
    expect(verificar.estado, verificar.texto).toBe(403);
    const devolver = await profe.campus('POST', `/api/campuses/${campus.australis}/grades/submission/return`, { note: 'Me devuelvo mis notas' });
    expect(devolver.estado, devolver.texto).toBe(403);
    const alumnaEnvia = await alumnaUno.campus('POST', `/api/campuses/${campus.australis}/grades/submission/send`, {});
    expect(alumnaEnvia.estado, alumnaEnvia.texto).toBe(403);
    const estado = await profe.campus('GET', `/api/campuses/${campus.australis}/grades/submission`);
    expect(estado.json.status).toBe('sent');
    const sinNota = await admin.campus('POST', `/api/campuses/${campus.australis}/grades/submission/return`, { note: '  ' });
    expect(sinNota.estado, sinNota.texto).toBe(422);
  });
});

test.describe('cupo del resumen con IA', () => {
  test('pasado el cupo diario del resumen, la llamada se rechaza con 429 y el modelo no recibe más pedidos', async ({ browser }) => {
    const usadas = (await profe.campus('GET', `/api/classes/${claseId}/summary`)).json.quota.used as number;

    fijarAjusteGlobal('ai.summary.daily_quota', String(usadas + 2));
    await reiniciarModelo();
    for (let i = 0; i < 2; i++) {
      const r = await profe.campus('POST', `/api/classes/${claseId}/summary/generate`, { overwrite: true });
      expect(r.estado, r.texto).toBe(200);
    }
    expect(await pedidosAlModelo()).toHaveLength(2);

    const pasado = await profe.campus('POST', `/api/classes/${claseId}/summary/generate`, { overwrite: true });
    expect(pasado.estado, pasado.texto).toBe(429);
    expect(await pedidosAlModelo()).toHaveLength(2);
    const vista = await profe.campus('GET', `/api/classes/${claseId}/summary`);
    expect(vista.json.quota.remaining).toBe(0);
    expect(vista.json.quota.used).toBe(vista.json.quota.limit);

    const { ctx, pagina } = await paginaDe(browser, profe);
    await pagina.goto(`${origenDe('campus')}/classes/${claseId}`);
    await expect(pagina.getByText('Alcanzaste el límite diario.')).toBeVisible();
    await expect(pagina.getByRole('button', { name: 'Volver a generar' })).toBeDisabled();
    await ctx.close();

    const otroProfe = await profe2.campus('POST', `/api/classes/${claseId}/summary/generate`, {});
    expect([403, 404]).toContain(otroProfe.estado);

    fijarAjusteGlobal('ai.summary.daily_quota', '0');
    const enCero = await profe.campus('POST', `/api/classes/${claseId}/summary/generate`, { overwrite: true });
    expect(enCero.estado, enCero.texto).toBe(429);
    expect(await pedidosAlModelo()).toHaveLength(2);
  });
});
