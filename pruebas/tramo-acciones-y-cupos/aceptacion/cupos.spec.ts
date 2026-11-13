import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearTestSinDocker, expect, OWNER, ADMIN_AUSTRAL, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, PENDIENTE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import { levantarNucleo } from '../../comun/nucleo.ts';
import {
  AUSTRAL,
  DEMO,
  auditoriaDe,
  consumir,
  cuentaNueva,
  cupoDelCurso,
  cuposAdmin,
  cursoDePrueba,
  idDe,
  ok,
  ponerCupoProfesor,
  ponerCupoUniversidad,
  ponerPredeterminado,
  profesorEn,
  sesionDe,
  sesionReautenticada,
  universidadConProfesores,
  universidadDe,
} from '../lib.ts';

const test = crearTestSinDocker();

test.describe('cupos de tokens: asignación y reparto', () => {
  test('el límite en USD de cada universidad pasa a ser su cupo en tokens', async ({ nucleo }) => {
    const owner = await sesionDe(nucleo, OWNER);
    const r = ok(await owner.get('/api/owner/cupos'), 'cupos del owner');
    expect(r.mes).toBe(new Date().toISOString().slice(0, 7));
    const austral = r.universidades.find((x: any) => x.nombre === AUSTRAL);
    const demo = r.universidades.find((x: any) => x.nombre === DEMO);
    expect(austral).toMatchObject({ cupo: 40_000_000, usado: 0, porcentaje: 0, aviso: false, repartido: 0, reserva: 40_000_000, deshabilitada: false });
    expect(demo.cupo).toBe(20_000_000);
    expect(Number(nucleo.consultar('SELECT cupo_tokens FROM universidades WHERE nombre = ?', AUSTRAL)[0].cupo_tokens)).toBe(40_000_000);
    const admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    expect(ok(await admin.get('/api/admin/universidad'), 'universidad').cupo_tokens).toBe(40_000_000);
    const dir = path.join(RAIZ_REPO, 'nucleo', 'migraciones');
    const migracion = fs.readdirSync(dir).find((f) => /^6001_.*\.sql$/.test(f));
    expect(migracion, 'falta la migración 6001').toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, migracion!), 'utf8');
    expect(sql).toMatch(/cupo_tokens/);
    expect(sql).toMatch(/limite_usd\s*\*\s*1000000/);
  });

  test('sembrar acepta el cupo en tokens o lo saca del límite en USD', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-semilla-'));
    const archivo = path.join(dir, 'datos.json');
    fs.writeFileSync(
      archivo,
      JSON.stringify({
        universidades: [
          { nombre: 'Uni con Cupo', dominios: ['concupo.edu.ar'], cupo_tokens: 1_234_567 },
          { nombre: 'Uni con USD', dominios: ['conusd.edu.ar'], limite_usd: 3 },
          { nombre: 'Uni sin Nada', dominios: ['sinnada.edu.ar'] },
        ],
        usuarios: [],
        cursos: [],
      }),
    );
    const n = await levantarNucleo({ semilla: archivo, owner: OWNER });
    try {
      const cupo = (nombre: string) => Number(n.consultar('SELECT cupo_tokens FROM universidades WHERE nombre = ?', nombre)[0].cupo_tokens);
      expect(cupo('Uni con Cupo')).toBe(1_234_567);
      expect(cupo('Uni con USD')).toBe(3_000_000);
      expect(cupo('Uni sin Nada')).toBe(20_000_000);
    } finally {
      await n.cerrar();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('el owner asigna el cupo mensual de una universidad', async ({ nucleo }) => {
    const { uni, owner } = await universidadConProfesores(nucleo, OWNER, 0);
    let lista = ok(await owner.get('/api/owner/cupos'), 'cupos');
    expect(lista.universidades.find((x: any) => x.id === uni.id).cupo).toBe(20_000_000);
    const r = await ponerCupoUniversidad(owner, uni.id, 5_000_000);
    expect(r).toMatchObject({ id: uni.id, nombre: uni.nombre, cupo: 5_000_000, usado: 0, porcentaje: 0, aviso: false, repartido: 0, reserva: 5_000_000 });
    lista = ok(await owner.get('/api/owner/cupos'), 'cupos');
    expect(lista.universidades.find((x: any) => x.id === uni.id).cupo).toBe(5_000_000);
    const ev = auditoriaDe(nucleo, 'cupo_universidad', uni.nombre).pop();
    expect(ev).toBeTruthy();
    expect(Number(ev.universidad_id)).toBe(uni.id);
    expect(String(ev.detalle)).toContain('5000000');

    const sufijo = Math.random().toString(36).slice(2, 8);
    const nueva = ok(
      await owner.post('/api/owner/universidades', { nombre: `Con cupo ${sufijo}`, dominio: `cc${sufijo}.edu.ar`, email_administrador: `admin@cc${sufijo}.edu.ar`, cupo_tokens: 777_000 }),
      'crear universidad',
      201,
    );
    expect(Number(nucleo.consultar('SELECT cupo_tokens FROM universidades WHERE id = ?', nueva.id)[0].cupo_tokens)).toBe(777_000);
  });

  test('el administrador reparte con un predeterminado y excepciones; lo no repartido queda como reserva', async ({ nucleo }) => {
    const { uni, owner, admin, profesores } = await universidadConProfesores(nucleo, OWNER, 3);
    const comun = await cuentaNueva(nucleo, uni.dominio, 'comun');
    await ponerCupoUniversidad(owner, uni.id, 1_000_000);
    let c = await cuposAdmin(admin);
    expect(c.universidad).toMatchObject({ id: uni.id, cupo: 1_000_000, usado: 0, repartido: 0, reserva: 1_000_000 });
    expect(c.predeterminado).toBeNull();
    expect(c.profesores.map((p: any) => p.id).sort()).toEqual(profesores.map((p) => p.id).sort());
    expect(c.profesores.map((p: any) => p.id)).not.toContain(comun.id);
    for (const p of c.profesores) expect(p).toMatchObject({ cupo: null, propio: false, usado: 0, porcentaje: null, aviso: false });
    const nombres = c.profesores.map((p: any) => p.nombre);
    expect(nombres).toEqual([...nombres].sort((a: string, b: string) => a.localeCompare(b, 'es')));

    c = await ponerPredeterminado(admin, 200_000);
    expect(c.predeterminado).toBe(200_000);
    expect(c.universidad).toMatchObject({ repartido: 600_000, reserva: 400_000 });
    for (const p of c.profesores) expect(p).toMatchObject({ cupo: 200_000, propio: false, porcentaje: 0 });

    c = await ponerCupoProfesor(admin, profesores[0]!.id, 300_000);
    expect(profesorEn(c, profesores[0]!.id)).toMatchObject({ cupo: 300_000, propio: true });
    expect(profesorEn(c, profesores[1]!.id)).toMatchObject({ cupo: 200_000, propio: false });
    expect(c.universidad).toMatchObject({ repartido: 700_000, reserva: 300_000 });
    expect(Number(nucleo.consultar('SELECT tokens FROM cupos_profesor WHERE usuario_id = ?', profesores[0]!.id)[0].tokens)).toBe(300_000);

    c = await ponerCupoProfesor(admin, profesores[1]!.id, 0);
    expect(profesorEn(c, profesores[1]!.id)).toMatchObject({ cupo: 0, propio: true });
    expect(c.universidad.repartido).toBe(500_000);

    c = await ponerCupoProfesor(admin, profesores[0]!.id, null);
    expect(profesorEn(c, profesores[0]!.id)).toMatchObject({ cupo: 200_000, propio: false });
    c = await ponerPredeterminado(admin, null);
    expect(c.predeterminado).toBeNull();
    expect(profesorEn(c, profesores[0]!.id).cupo).toBeNull();
    expect(c.universidad).toMatchObject({ repartido: 0, reserva: 1_000_000 });

    expect(auditoriaDe(nucleo, 'cupo_predeterminado', uni.nombre).length).toBeGreaterThanOrEqual(2);
    const ev = auditoriaDe(nucleo, 'cupo_profesor', profesores[0]!.email).pop();
    expect(ev).toBeTruthy();
    expect(Number(ev.universidad_id)).toBe(uni.id);
    expect(Number(ev.actor_id)).toBe(idDe(nucleo, uni.admin));
  });

  test('el owner reparte en cualquier universidad indicándola', async ({ nucleo }) => {
    const { uni, owner, profesores } = await universidadConProfesores(nucleo, OWNER, 1);
    const q = `?universidad=${uni.id}`;
    const c = await cuposAdmin(owner, q);
    expect(c.universidad.id).toBe(uni.id);
    const r = await ponerCupoProfesor(owner, profesores[0]!.id, 50_000, q);
    expect(profesorEn(r, profesores[0]!.id)).toMatchObject({ cupo: 50_000, propio: true });
    const p = await ponerPredeterminado(owner, 10_000, q);
    expect(p.predeterminado).toBe(10_000);
    const ev = auditoriaDe(nucleo, 'cupo_profesor', profesores[0]!.email).pop();
    expect(Number(ev.actor_id)).toBe(idDe(nucleo, OWNER));
  });

  test('cada administrador ve los profesores de su universidad', async ({ nucleo }) => {
    const admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const c = await cuposAdmin(admin);
    expect(c.universidad.id).toBe(universidadDe(nucleo, AUSTRAL));
    const mails = c.profesores.map((p: any) => p.email);
    for (const e of [PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, PENDIENTE_AUSTRAL]) expect(mails).toContain(e);
    expect(mails).not.toContain(ALUMNO_AUSTRAL);
    expect(mails).not.toContain('profe@demo.edu.ar');
    for (const e of mails) expect(e).toMatch(/austral\.edu\.ar$/);
  });
});

test.describe('cupos de tokens: consumo visible', () => {
  test('el administrador ve el usado por profesor, el owner por universidad y el profesor lo que le queda, con aviso al 80 % y sin mails', async ({ nucleo }) => {
    const { uni, owner, admin, profesores } = await universidadConProfesores(nucleo, OWNER, 2);
    const [p0, p1] = profesores as [any, any];
    await ponerCupoUniversidad(owner, uni.id, 1_000_000);
    await ponerCupoProfesor(admin, p0.id, 100_000);
    const curso = cursoDePrueba(nucleo, { universidad: uni.id, dueno: p0.email, profesores: [p1.email] });
    const mails = nucleo.cantidadMails();

    let yo = await cupoDelCurso(p0.cliente, curso);
    expect(yo).toMatchObject({ cupo: 100_000, usado: 0, restante: 100_000, porcentaje: 0, aviso: false, agotado: null, modelo_disponible: true });
    expect(yo.universidad).toMatchObject({ cupo: 1_000_000, usado: 0, restante: 1_000_000, porcentaje: 0 });

    consumir(nucleo, { curso, universidad: uni.id, usuario: p0.id, tokens: 85_000 });
    yo = await cupoDelCurso(p0.cliente, curso);
    expect(yo).toMatchObject({ usado: 85_000, restante: 15_000, porcentaje: 85, aviso: true, agotado: null });
    expect(yo.universidad).toMatchObject({ usado: 85_000, restante: 915_000, porcentaje: 8 });
    let c = await cuposAdmin(admin);
    expect(profesorEn(c, p0.id)).toMatchObject({ usado: 85_000, porcentaje: 85, aviso: true });
    expect(profesorEn(c, p1.id)).toMatchObject({ usado: 0, aviso: false, cupo: null });
    expect(c.universidad).toMatchObject({ usado: 85_000, aviso: false });
    let o = ok(await owner.get('/api/owner/cupos'), 'owner').universidades.find((x: any) => x.id === uni.id);
    expect(o).toMatchObject({ cupo: 1_000_000, usado: 85_000, porcentaje: 8, aviso: false });

    const otro = await cupoDelCurso(p1.cliente, curso);
    expect(otro).toMatchObject({ cupo: null, usado: 0, porcentaje: null, restante: 915_000, aviso: false });

    consumir(nucleo, { curso, universidad: uni.id, usuario: p1.id, tokens: 720_000 });
    c = await cuposAdmin(admin);
    expect(c.universidad).toMatchObject({ usado: 805_000, porcentaje: 80, aviso: true });
    o = ok(await owner.get('/api/owner/cupos'), 'owner').universidades.find((x: any) => x.id === uni.id);
    expect(o).toMatchObject({ usado: 805_000, aviso: true });
    expect((await cupoDelCurso(p1.cliente, curso)).aviso).toBe(true);

    consumir(nucleo, { curso, universidad: uni.id, usuario: p0.id, tokens: 15_000 });
    yo = await cupoDelCurso(p0.cliente, curso);
    expect(yo).toMatchObject({ usado: 100_000, restante: 0, porcentaje: 100, agotado: 'profesor' });
    consumir(nucleo, { curso, universidad: uni.id, usuario: p1.id, tokens: 200_000 });
    const p1Yo = await cupoDelCurso(p1.cliente, curso);
    expect(p1Yo).toMatchObject({ restante: 0, agotado: 'universidad' });
    expect(nucleo.cantidadMails()).toBe(mails);
  });

  test('el uso de otro mes no cuenta', async ({ nucleo }) => {
    const { uni, owner, profesores } = await universidadConProfesores(nucleo, OWNER, 1);
    await ponerCupoUniversidad(owner, uni.id, 50_000);
    const curso = cursoDePrueba(nucleo, { universidad: uni.id, dueno: profesores[0]!.email });
    const db = nucleo.base();
    try {
      db.prepare(
        `INSERT INTO uso_modelo (curso_id, universidad_id, mes, fecha, ruta, estado, modelo, tokens_entrada, tokens_salida, tokens_cache_creacion, tokens_cache_lectura, usd, usuario_id, tokens)
         VALUES (?, ?, '2020-01', '2020-01-15T10:00:00Z', '/v1/messages', 200, 'x', 900000, 0, 0, 0, 0, ?, 900000)`,
      ).run(curso, uni.id, profesores[0]!.id);
    } finally {
      db.close();
    }
    const yo = await cupoDelCurso(profesores[0]!.cliente, curso);
    expect(yo).toMatchObject({ usado: 0, restante: 50_000, agotado: null });
  });
});

test.describe('cupos de tokens: interfaz', () => {
  test('Owner › Cupos muestra asignado y consumido y guarda el cupo', async ({ nucleo, paginaComo }) => {
    const { uni, owner, profesores } = await universidadConProfesores(nucleo, OWNER, 1);
    await ponerCupoUniversidad(owner, uni.id, 1_000_000);
    const curso = cursoDePrueba(nucleo, { universidad: uni.id, dueno: profesores[0]!.email });
    consumir(nucleo, { curso, universidad: uni.id, usuario: profesores[0]!.id, tokens: 900_000 });
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, '/owner'));
    const tab = page.locator('#tabs-owner [data-otab="cupos"]');
    await expect(tab).toHaveText('Cupos');
    await tab.click();
    const fila = page.locator(`tr[data-cupo-universidad="${uni.id}"]`);
    await expect(fila).toBeVisible();
    await expect(fila).toHaveAttribute('data-usado', '900000');
    await expect(fila.locator('.pill.ambar')).toContainText('%');
    await expect(page.locator(`tr[data-cupo-universidad="${universidadDe(nucleo, AUSTRAL)}"]`)).toBeVisible();
    const input = fila.locator(`input[data-cupo="${uni.id}"]`);
    await input.fill('2500000');
    await input.press('Enter');
    await expect(page.locator('#aviso')).toContainText('Cupo guardado');
    await expect.poll(async () => Number(nucleo.consultar('SELECT cupo_tokens FROM universidades WHERE id = ?', uni.id)[0].cupo_tokens)).toBe(2_500_000);
    await expect(fila.locator('.pill.ambar')).toHaveCount(0);
  });

  test('Administración › Cupos reparte, muestra la reserva y rechaza pasar el total', async ({ nucleo, paginaComo }) => {
    const { uni, owner, admin, profesores } = await universidadConProfesores(nucleo, OWNER, 2);
    await ponerCupoUniversidad(owner, uni.id, 1_000_000);
    const curso = cursoDePrueba(nucleo, { universidad: uni.id, dueno: profesores[0]!.email });
    const page = await paginaComo(admin);
    await page.goto(nucleo.url(undefined, '/administracion'));
    await page.locator('#tabs-admin [data-tab="cupos"]').click();
    await expect(page.locator('#cupo-total')).toHaveAttribute('data-cupo', '1000000');
    await expect(page.locator('#cupo-reserva')).toHaveAttribute('data-reserva', '1000000');
    await expect(page.locator('#cupo-aviso')).toBeHidden();

    await page.locator('#cupo-predeterminado').fill('300000');
    await page.locator('#cupo-predeterminado').press('Enter');
    await expect(page.locator('#aviso')).toContainText('Cupo guardado');
    await expect(page.locator('#cupo-reserva')).toHaveAttribute('data-reserva', '400000');
    await expect(page.locator('#cupo-reserva')).toHaveAttribute('data-repartido', '600000');

    const p0 = profesores[0]!.id;
    const campo = page.locator(`input[data-cupo-prof="${p0}"]`);
    await campo.fill('100000');
    await campo.press('Enter');
    await expect(page.locator('#cupo-reserva')).toHaveAttribute('data-reserva', '600000');
    expect((await cuposAdmin(admin)).profesores.find((x: any) => x.id === p0)).toMatchObject({ cupo: 100_000, propio: true });

    await campo.fill('5000000');
    await campo.press('Enter');
    await expect(page.locator('#aviso')).toContainText('supera el cupo');
    await expect(campo).toHaveValue('100000');
    expect((await cuposAdmin(admin)).profesores.find((x: any) => x.id === p0).cupo).toBe(100_000);

    await ponerPredeterminado(admin, null);
    consumir(nucleo, { curso, universidad: uni.id, usuario: p0, tokens: 90_000 });
    consumir(nucleo, { curso, universidad: uni.id, usuario: profesores[1]!.id, tokens: 720_000 });
    await page.reload();
    await page.locator('#tabs-admin [data-tab="cupos"]').click();
    await expect(page.locator('#cupo-aviso')).toBeVisible();
    await expect(page.locator('#cupo-aviso')).toContainText('80');
    await expect(page.locator('#cupo-total')).toHaveAttribute('data-usado', '810000');
    const fila = page.locator(`tr[data-cupo-profesor="${p0}"]`);
    await expect(fila).toHaveAttribute('data-usado', '90000');
    await expect(fila.locator('.pill.ambar')).toContainText('%');
    await expect(page.locator(`tr[data-cupo-profesor="${profesores[1]!.id}"] .pill.ambar`)).toHaveCount(0);

    await page.locator('#tabs-admin [data-tab="config"]').click();
    await expect(page.locator('[data-quitardom]').first()).toBeVisible();
    await expect(page.locator('#limite')).toHaveCount(0);
  });

  test('el owner reparte desde Administración de otra universidad', async ({ nucleo, paginaComo }) => {
    const { uni, profesores } = await universidadConProfesores(nucleo, OWNER, 1);
    const owner = await sesionReautenticada(nucleo, OWNER);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, `/administracion?universidad=${uni.id}`));
    await page.locator('#tabs-admin [data-tab="cupos"]').click();
    const campo = page.locator(`input[data-cupo-prof="${profesores[0]!.id}"]`);
    await campo.fill('12345');
    await campo.press('Enter');
    await expect(page.locator('#aviso')).toContainText('Cupo guardado');
    await expect.poll(async () => Number(nucleo.consultar('SELECT tokens FROM cupos_profesor WHERE usuario_id = ?', profesores[0]!.id)[0]?.tokens)).toBe(12_345);
  });
});
