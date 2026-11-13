import crypto from 'node:crypto';
import { Cliente } from '../../comun/http.ts';
import {
  ADMIN_AUSTRAL,
  ALGORITMOS,
  ALUMNA_REDES,
  ALUMNO_DEMO,
  ALUMNO_REDES,
  DUENO_REDES,
  ETICA,
  OWNER,
  PROFE_DEMO,
  PROFE_REDES,
  PROFE_SIN_CURSOS,
  QUIMICA,
  SIN_CURSOS,
  MIEMBROS_REDES,
  crearTestDatos,
  expect,
} from '../fixtures.ts';
import {
  bajar,
  entregar,
  entregarOk,
  fechaEnRango,
  idUsuario,
  listarArchivos,
  ponerNota,
  ponerNotaOk,
  sesion,
  subir,
  subirOk,
  verEntregas,
  verHistorial,
  verNotas,
  cursoAislado,
} from '../lib/datos.ts';

const test = crearTestDatos();
const C = { id: '' };
test.beforeAll(({ nucleo }) => {
  C.id = cursoAislado(nucleo, 'per', MIEMBROS_REDES);
});
test.describe.configure({ mode: 'serial' });

let archivoAlumna = '';
let archivoAlumno = '';
let entregaAlumna = 0;

test.describe('permisos sobre archivos, entregas y notas', () => {
  test.beforeAll(async ({ nucleo }) => {
    const alumna = await sesion(nucleo, ALUMNA_REDES);
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const profe = await sesion(nucleo, PROFE_REDES);
    archivoAlumna = (await subirOk(alumna, C.id, 'privado-sofia.pdf', '%PDF secreto de Sofía')).id;
    archivoAlumno = (await subirOk(alumno, C.id, 'propio.txt', 'de Tomás')).id;
    entregaAlumna = (await entregarOk(alumna, C.id, { actividad: 'tp1', texto: 'texto privado de Sofía', archivo_id: archivoAlumna })).id;
    await entregarOk(alumno, C.id, { actividad: 'tp1', texto: 'de Tomás' });
    await ponerNotaOk(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNA_REDES), actividad: 'tp1', valor: '4', comentario: 'nota privada de Sofía' });
    await ponerNotaOk(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNA_REDES), actividad: 'tp1', valor: '5' });
    await ponerNotaOk(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '8' });
  });

  test('un alumno no ve las entregas de otro, ni filtrando por su id', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const r = await verEntregas(alumno, C.id);
    expect(r.status).toBe(200);
    expect(r.texto).not.toContain('Sofía');
    expect(r.json.entregas.map((e: any) => e.id)).not.toContain(entregaAlumna);
    const filtro = await verEntregas(alumno, C.id, { usuario: idUsuario(nucleo, ALUMNA_REDES) });
    expect(filtro.status).toBe(403);
    expect(filtro.json.error).toBe('prohibido');
    expect(filtro.texto).not.toContain('Sofía');
  });

  test('un alumno no ve las notas de otro ni el historial', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const r = await verNotas(alumno, C.id);
    expect(r.status).toBe(200);
    expect(r.json.notas.map((n: any) => n.usuario.email)).toEqual([ALUMNO_REDES]);
    expect(r.texto).not.toContain('Sofía');
    const filtro = await verNotas(alumno, C.id, { usuario: idUsuario(nucleo, ALUMNA_REDES) });
    expect(filtro.status).toBe(403);
    for (const q of [{}, { usuario: idUsuario(nucleo, ALUMNO_REDES) }]) {
      const h = await verHistorial(alumno, C.id, q);
      expect(h.status).toBe(403);
      expect(h.json.error).toBe('prohibido');
    }
  });

  test('un alumno no baja ni lista los archivos de otro alumno', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const b = await bajar(alumno, C.id, archivoAlumna);
    expect(b.status).toBe(404);
    expect(b.texto).not.toContain('secreto');
    const l = await listarArchivos(alumno, C.id);
    expect(l.json.archivos.map((a: any) => a.id)).not.toContain(archivoAlumna);
    expect(l.texto).not.toContain('privado-sofia');
  });

  test('un alumno no pone notas, ni a otros ni a sí mismo, ni por token', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    for (const usuario of [idUsuario(nucleo, ALUMNO_REDES), idUsuario(nucleo, ALUMNA_REDES)]) {
      const r = await ponerNota(alumno, C.id, { usuario_id: usuario, actividad: 'tp1', valor: '10' });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('prohibido');
    }
    const total = nucleo.consultar("SELECT COUNT(*) AS n FROM notas WHERE valor = '10' AND curso_id = ?", C.id)[0];
    expect(Number(total.n)).toBe(0);
  });

  test('un alumno no sube material', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const r = await subir(alumno, C.id, 'material.pdf', '%PDF', { material: true });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('prohibido');
  });

  test('nadie entrega en nombre de otro ni elige la hora', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const antes = Date.now();
    const r = await entregar(alumno, C.id, {
      actividad: 'tp9',
      texto: 'intento',
      usuario_id: idUsuario(nucleo, ALUMNA_REDES),
      usuario: { id: idUsuario(nucleo, ALUMNA_REDES), email: ALUMNA_REDES },
      fecha: '2020-01-01T00:00:00Z',
      creada_en: '2020-01-01T00:00:00Z',
      via: 'curso',
      id: 1,
    });
    if (r.status === 201) {
      expect(r.json.usuario.email).toBe(ALUMNO_REDES);
      expect(r.json.via).toBe('plataforma');
      fechaEnRango(r.json.fecha, antes, Date.now());
      expect(r.json.id).not.toBe(1);
    } else {
      expect(r.status).toBe(400);
    }
    const deSofia = await verEntregas(await sesion(nucleo, ALUMNA_REDES), C.id, { actividad: 'tp9' });
    expect(deSofia.json.entregas).toHaveLength(0);
  });

  test('no se entrega con el archivo de otra persona ni con uno inventado', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const profe = await sesion(nucleo, PROFE_REDES);
    const material = (await subirOk(profe, C.id, 'enunciado.pdf', '%PDF', { material: true })).id;
    for (const archivo of [archivoAlumna, material, crypto.randomBytes(16).toString('hex'), '../' + archivoAlumno, 'x']) {
      const r = await entregar(alumno, C.id, { actividad: 'tp1', archivo_id: archivo });
      expect([400, 404], archivo).toContain(r.status);
    }
    const otroCurso = (await subirOk(alumno, ALGORITMOS, 'algo.txt', 'de algoritmos')).id;
    const r = await entregar(alumno, C.id, { actividad: 'tp1', archivo_id: otroCurso });
    expect(r.status).toBe(404);
  });

  test('las notas solo se ponen a alumnos inscriptos en ese curso', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_REDES);
    const r1 = await ponerNota(profe, C.id, { usuario_id: idUsuario(nucleo, DUENO_REDES), actividad: 'tp1', valor: '10' });
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe('no_es_alumno');
    for (const email of [SIN_CURSOS, ALUMNO_DEMO]) {
      const r = await ponerNota(profe, C.id, { usuario_id: idUsuario(nucleo, email), actividad: 'tp1', valor: '10' });
      expect(r.status, email).toBe(404);
    }
    const r3 = await ponerNota(profe, C.id, { usuario_id: 999999, actividad: 'tp1', valor: '10' });
    expect(r3.status).toBe(404);
  });

  test('quienes no están inscriptos, aunque sean administrador u owner, no ven nada del curso', async ({ nucleo }) => {
    for (const email of [ADMIN_AUSTRAL, OWNER, SIN_CURSOS, PROFE_SIN_CURSOS, PROFE_DEMO]) {
      const c = await sesion(nucleo, email);
      for (const r of [
        await verEntregas(c, C.id),
        await verNotas(c, C.id),
        await verHistorial(c, C.id),
        await listarArchivos(c, C.id),
        await bajar(c, C.id, archivoAlumna),
        await entregar(c, C.id, { actividad: 'tp1', texto: 'intruso' }),
        await ponerNota(c, C.id, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '1' }),
        await subir(c, C.id, 'intruso.txt', 'x'),
      ]) {
        expect(r.status, email).toBe(404);
        expect(r.texto, email).not.toContain('Sofía');
      }
    }
  });

  test('un docente de otro curso no ve los datos de este; un alumno de un curso no ve otro curso', async ({ nucleo }) => {
    const duenoEtica = await sesion(nucleo, PROFE_REDES);
    const enEtica = await verEntregas(duenoEtica, ETICA);
    expect(enEtica.status).toBe(200);
    const alumnoDeEtica = await sesion(nucleo, DUENO_REDES);
    expect((await verHistorial(alumnoDeEtica, ETICA)).status).toBe(403);
    expect((await ponerNota(alumnoDeEtica, ETICA, { usuario_id: idUsuario(nucleo, DUENO_REDES), actividad: 'x', valor: '10' })).status).toBe(403);
    const profeDemo = await sesion(nucleo, PROFE_DEMO);
    expect((await verEntregas(profeDemo, C.id)).status).toBe(404);
    expect((await bajar(profeDemo, QUIMICA, archivoAlumna)).status).toBe(404);
    const dueno = await sesion(nucleo, DUENO_REDES);
    expect((await bajar(dueno, ALGORITMOS, archivoAlumna)).status).toBe(404);
  });

  test('adivinar identificadores de archivos no sirve', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    for (let i = 0; i < 20; i++) {
      const r = await bajar(dueno, C.id, crypto.randomBytes(16).toString('hex'));
      expect(r.status).toBe(404);
    }
    for (const raro of ['..%2F..%2Fdatos%2Fcampusia.db', '%2e%2e', archivoAlumna.toUpperCase(), `${archivoAlumna}%00`, `${archivoAlumna}/..`, '*']) {
      const r = await alumno.get(`/api/cursos/${C.id}/archivos/${raro}`);
      expect([400, 404], raro).toContain(r.status);
      expect(r.texto).not.toContain('secreto');
      expect(r.texto).not.toContain('SQLite');
    }
  });

  test('las modificaciones con cookie exigen el origen de la plataforma', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const profe = await sesion(nucleo, PROFE_REDES);
    for (const op of [
      { origen: null },
      { origen: 'https://evil.example' },
      { origen: `http://${C.id}-curso.campusia.prueba:${nucleo.puerto}` },
      { sinEncabezadoPropio: true },
    ]) {
      const e = await entregar(alumno, C.id, { actividad: 'tp1', texto: 'csrf' }, op);
      expect(e.status).toBe(403);
      expect(e.json.error).toBe('origen_invalido');
      const s = await subir(alumno, C.id, 'csrf.txt', 'x', op);
      expect(s.status).toBe(403);
      const n = await ponerNota(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '1' }, op);
      expect(n.status).toBe(403);
    }
    const r = await verEntregas(alumno, C.id, { actividad: 'tp1' });
    expect(r.texto).not.toContain('csrf');
  });

  test('sin sesión todo responde 401', async ({ cliente }) => {
    const c = cliente();
    for (const r of [
      await verEntregas(c, C.id),
      await verNotas(c, C.id),
      await verHistorial(c, C.id),
      await listarArchivos(c, C.id),
      await bajar(c, C.id, archivoAlumna),
      await entregar(c, C.id, { actividad: 'tp1', texto: 'x' }),
      await subir(c, C.id, 'x.txt', 'x'),
    ]) {
      expect(r.status).toBe(401);
    }
  });
});
