import { crearTestSinDocker, expect, OWNER, ADMIN_AUSTRAL, ADMIN_DEMO, PROFE_AUSTRAL, PROFE_DEMO, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import {
  AUSTRAL,
  DEMO,
  cuentaNueva,
  cuposAdmin,
  cursoDePrueba,
  idDe,
  ok,
  ponerCupoProfesor,
  ponerCupoUniversidad,
  sesionDe,
  tokenViejo,
  universidadConProfesores,
  universidadDe,
} from '../lib.ts';

const test = crearTestSinDocker();

function predeterminadoDe(n: any, uni: number) {
  return n.consultar('SELECT cupo_profesor_predeterminado AS p FROM universidades WHERE id = ?', uni)[0].p;
}

function cupoDe(n: any, uni: number) {
  return Number(n.consultar('SELECT cupo_tokens FROM universidades WHERE id = ?', uni)[0].cupo_tokens);
}

function propiosDe(n: any, uni: number) {
  return n.consultar('SELECT usuario_id, tokens FROM cupos_profesor WHERE universidad_id = ? ORDER BY usuario_id', uni);
}

test.describe('nadie asigna ni reparte cupos que no le tocan', () => {
  test('un administrador no toca los cupos de otra universidad', async ({ nucleo }) => {
    const admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const demo = universidadDe(nucleo, DEMO);
    const profeDemo = idDe(nucleo, PROFE_DEMO);
    const antes = { cupo: cupoDe(nucleo, demo), pred: predeterminadoDe(nucleo, demo), propios: propiosDe(nucleo, demo) };
    const q = `?universidad=${demo}`;
    for (const [metodo, ruta, cuerpo] of [
      ['GET', `/api/admin/cupos${q}`, undefined],
      ['PUT', `/api/admin/cupos/predeterminado${q}`, { tokens: 1 }],
      ['PUT', `/api/admin/cupos/profesores/${profeDemo}${q}`, { tokens: 1 }],
      ['PUT', `/api/admin/cupos/profesores/${profeDemo}`, { tokens: 1 }],
    ] as Array<[string, string, any]>) {
      const r = await admin.pedir(metodo, ruta, cuerpo);
      expect(r.status, `${metodo} ${ruta}`).toBe(404);
      expect(r.texto).not.toContain(PROFE_DEMO);
    }
    const propia = ok(await admin.get('/api/admin/cupos'), 'cupos propios');
    expect(propia.universidad.id).toBe(universidadDe(nucleo, AUSTRAL));
    expect(JSON.stringify(propia)).not.toContain(PROFE_DEMO);
    expect({ cupo: cupoDe(nucleo, demo), pred: predeterminadoDe(nucleo, demo), propios: propiosDe(nucleo, demo) }).toEqual(antes);
  });

  test('solo el owner asigna el cupo de una universidad', async ({ nucleo }) => {
    const austral = universidadDe(nucleo, AUSTRAL);
    const demo = universidadDe(nucleo, DEMO);
    const antes = [cupoDe(nucleo, austral), cupoDe(nucleo, demo)];
    for (const email of [ADMIN_AUSTRAL, ADMIN_DEMO, PROFE_AUSTRAL, ALUMNO_AUSTRAL]) {
      const c = await sesionDe(nucleo, email);
      for (const uni of [austral, demo]) {
        const r = await c.put(`/api/owner/universidades/${uni}/cupo`, { tokens: 999_999_999 });
        expect(r.status, `${email} sobre ${uni}`).toBe(403);
      }
      expect((await c.get('/api/owner/cupos')).status, email).toBe(403);
      const admin = await c.put(`/api/admin/cupos/predeterminado`, { tokens: 1, cupo: 999_999_999, cupo_tokens: 999_999_999 });
      if (email.startsWith('ana') || email.startsWith('admin')) expect(admin.status).toBe(200);
      else expect(admin.status, email).toBe(403);
      if (admin.status === 200) {
        expect(admin.json.universidad.cupo).toBe(email === ADMIN_AUSTRAL ? antes[0] : antes[1]);
        ok(await c.put('/api/admin/cupos/predeterminado', { tokens: null }), 'volver');
      }
    }
    const anon = new Cliente(nucleo);
    expect((await anon.put(`/api/owner/universidades/${austral}/cupo`, { tokens: 1 })).status).toBe(401);
    expect((await anon.get('/api/admin/cupos')).status).toBe(401);
    const owner = await sesionDe(nucleo, OWNER);
    const viejo = await tokenViejo(owner, ['owner:leer', 'owner:escribir']);
    expect((await anon.put(`/api/owner/universidades/${austral}/cupo`, { tokens: 1 }, { bearer: viejo })).status).toBe(401);
    expect((await owner.put(`/api/owner/universidades/${austral}/cupo`, { tokens: 1 }, { origen: null })).status).toBe(403);
    expect((await owner.put('/api/owner/universidades/99999999/cupo', { tokens: 1 })).status).toBe(404);
    expect([cupoDe(nucleo, austral), cupoDe(nucleo, demo)]).toEqual(antes);
  });

  test('un administrador no reparte más que el total de su universidad', async ({ nucleo }) => {
    const { uni, owner, admin, profesores } = await universidadConProfesores(nucleo, OWNER, 2);
    const [p0, p1] = profesores as [any, any];
    await ponerCupoUniversidad(owner, uni.id, 1_000_000);

    let r = await admin.put('/api/admin/cupos/predeterminado', { tokens: 600_000 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('cupo_excedido');
    expect(predeterminadoDe(nucleo, uni.id)).toBeNull();

    r = await admin.put(`/api/admin/cupos/profesores/${p0.id}`, { tokens: 1_000_001 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('cupo_excedido');
    expect(propiosDe(nucleo, uni.id)).toEqual([]);

    await ponerCupoProfesor(admin, p0.id, 600_000);
    r = await admin.put(`/api/admin/cupos/profesores/${p1.id}`, { tokens: 400_001 });
    expect(r.status).toBe(409);
    await ponerCupoProfesor(admin, p1.id, 400_000);
    r = await admin.put(`/api/admin/cupos/profesores/${p1.id}`, { tokens: 400_001 });
    expect(r.status).toBe(409);
    const otro = await cuentaNueva(nucleo, uni.dominio, 'prof');
    expect((await admin.put(`/api/admin/personas/${otro.id}/profesor`, { profesor: true })).status).toBe(200);
    r = await admin.put('/api/admin/cupos/predeterminado', { tokens: 1 });
    expect(r.status).toBe(409);
    expect(predeterminadoDe(nucleo, uni.id)).toBeNull();

    await ponerCupoUniversidad(owner, uni.id, 500_000);
    const c = await cuposAdmin(admin);
    expect(c.universidad).toMatchObject({ cupo: 500_000, repartido: 1_000_000, reserva: 0 });
    const baja = await ponerCupoProfesor(admin, p0.id, 550_000);
    expect(baja.universidad.repartido).toBe(950_000);
    r = await admin.put(`/api/admin/cupos/profesores/${otro.id}`, { tokens: 1 });
    expect(r.status).toBe(409);
    r = await admin.put(`/api/admin/cupos/profesores/${p0.id}`, { tokens: 560_000 });
    expect(r.status).toBe(409);
    expect(Number(propiosDe(nucleo, uni.id).find((x: any) => Number(x.usuario_id) === p0.id).tokens)).toBe(550_000);
  });

  test('los valores inválidos se rechazan sin cambiar nada', async ({ nucleo }) => {
    const { uni, owner, admin, profesores } = await universidadConProfesores(nucleo, OWNER, 1);
    const p0 = profesores[0]!.id;
    const cupo = cupoDe(nucleo, uni.id);
    for (const cuerpo of [{ tokens: -1 }, { tokens: 1.5 }, { tokens: '100' }, { tokens: 1_000_000_000_001 }, { tokens: true }, {}, { tokens: [1] }, { tokens: { valor: 1 } }]) {
      for (const [c, ruta] of [
        [admin, '/api/admin/cupos/predeterminado'],
        [admin, `/api/admin/cupos/profesores/${p0}`],
        [owner, `/api/owner/universidades/${uni.id}/cupo`],
      ] as Array<[Cliente, string]>) {
        const r = await c.put(ruta, cuerpo);
        expect(r.status, `${ruta} ${JSON.stringify(cuerpo)}`).toBe(400);
        expect(r.json.error).toBe('datos_invalidos');
      }
    }
    const nulo = await owner.put(`/api/owner/universidades/${uni.id}/cupo`, { tokens: null });
    expect(nulo.status).toBe(400);
    const texto = await owner.put(`/api/owner/universidades/${uni.id}/cupo`, undefined, { cuerpoCrudo: 'tokens=5', tipo: 'application/x-www-form-urlencoded' });
    expect([400, 415]).toContain(texto.status);
    expect(cupoDe(nucleo, uni.id)).toBe(cupo);
    expect(predeterminadoDe(nucleo, uni.id)).toBeNull();
    expect(propiosDe(nucleo, uni.id)).toEqual([]);
  });

  test('el cupo de un profesor solo se pone a profesores de la propia universidad', async ({ nucleo }) => {
    const { uni, admin } = await universidadConProfesores(nucleo, OWNER, 1);
    const comun = await cuentaNueva(nucleo, uni.dominio, 'comun');
    let r = await admin.put(`/api/admin/cupos/profesores/${comun.id}`, { tokens: 10 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('no_es_profesor');
    for (const ajeno of [idDe(nucleo, PROFE_AUSTRAL), idDe(nucleo, PROFE_DEMO), 99_999_999]) {
      r = await admin.put(`/api/admin/cupos/profesores/${ajeno}`, { tokens: 10 });
      expect(r.status, String(ajeno)).toBe(404);
    }
    expect(propiosDe(nucleo, uni.id)).toEqual([]);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM cupos_profesor WHERE usuario_id IN (?, ?)', idDe(nucleo, PROFE_AUSTRAL), idDe(nucleo, PROFE_DEMO))[0].n).toBe(0);
  });

  test('los campos de más no cambian de universidad ni de cupo', async ({ nucleo }) => {
    const { uni, owner, admin, profesores } = await universidadConProfesores(nucleo, OWNER, 1);
    const demo = universidadDe(nucleo, DEMO);
    const antesDemo = { cupo: cupoDe(nucleo, demo), pred: predeterminadoDe(nucleo, demo) };
    const r = ok(await admin.put('/api/admin/cupos/predeterminado', { tokens: 5, universidad_id: demo, universidad: demo, cupo_tokens: 1 }), 'predeterminado');
    expect(r.universidad.id).toBe(uni.id);
    expect(r.predeterminado).toBe(5);
    ok(await admin.put(`/api/admin/cupos/profesores/${profesores[0]!.id}`, { tokens: 7, usuario_id: idDe(nucleo, PROFE_DEMO), universidad_id: demo }), 'profesor');
    ok(await owner.put(`/api/owner/universidades/${uni.id}/cupo`, { tokens: 9_000, id: demo, universidad_id: demo }), 'owner');
    expect(cupoDe(nucleo, uni.id)).toBe(9_000);
    expect({ cupo: cupoDe(nucleo, demo), pred: predeterminadoDe(nucleo, demo) }).toEqual(antesDemo);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM cupos_profesor WHERE usuario_id = ?', idDe(nucleo, PROFE_DEMO))[0].n).toBe(0);
    const yo = await admin.post('/api/admin/invitaciones', { email: `p${Date.now()}@${uni.dominio}`, tipo: 'profesor', cupo_tokens: 1, cupo: 1 });
    expect([200, 201]).toContain(yo.status);
    expect(cupoDe(nucleo, uni.id)).toBe(9_000);
  });

  test('el cupo del panel Editar es solo para los docentes del curso', async ({ nucleo }) => {
    const curso = cursoDePrueba(nucleo, { universidad: universidadDe(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [ALUMNO_AUSTRAL] });
    const alumno = await sesionDe(nucleo, ALUMNO_AUSTRAL);
    const r = await alumno.get(`/api/cursos/${curso}/cupo`);
    expect(r.status).toBe(403);
    for (const email of [ADMIN_AUSTRAL, OWNER, PROFE_DEMO]) {
      const c = await sesionDe(nucleo, email);
      expect((await c.get(`/api/cursos/${curso}/cupo`)).status, email).toBe(404);
    }
    expect((await new Cliente(nucleo).get(`/api/cursos/${curso}/cupo`)).status).toBe(401);
    const duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    expect((await duena.get('/api/cursos/no-existe-curso/cupo')).status).toBe(404);
    expect((await duena.get(`/api/cursos/${curso}/cupo`)).status).toBe(200);
  });
});
