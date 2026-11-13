import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, PROFE_DEMO, ALUMNO_DEMO, OWNER, SIN_MARCA_AUSTRAL } from '../fixtures.ts';
import { aleatorio, entrar, reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { crearCurso, ejecutarSql, idAleatorio, sesion } from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ timeout: 300_000 });

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

async function cursoConCodigo(nucleo: any, email = PROFE_AUSTRAL) {
  const profe = await sesion(nucleo, email);
  const id = idAleatorio('cc');
  expect((await crearCurso(profe, { id })).status).toBe(201);
  const g = await profe.post(`/api/cursos/${id}/codigo`, {});
  expect(g.status, g.texto).toBe(200);
  return { profe, id, codigo: g.json.codigo as string };
}

async function cuentaNueva(nucleo: any, ip?: string) {
  const c = new Cliente(nucleo);
  const email = `${aleatorio('cod.')}@mail.austral.edu.ar`;
  await entrar(c, email);
  if (ip) c.ip = ip;
  return c;
}

function inscripto(nucleo: any, id: string, email: string) {
  return nucleo.consultar('SELECT i.rol FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? AND u.email = ?', id, email).length > 0;
}

test.describe('ataques al código de inscripción', () => {
  test('los códigos tienen el formato y la aleatoriedad del contrato', async ({ nucleo }) => {
    const { profe, id } = await cursoConCodigo(nucleo);
    const vistos = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const c = (await profe.post(`/api/cursos/${id}/codigo`, {})).json.codigo as string;
      expect(c).toMatch(new RegExp(`^CC[0-9A-F]-[${ALFABETO}]{6}$`));
      vistos.add(c);
    }
    expect(vistos.size).toBe(25);
    const sufijos = [...vistos].map((c) => c.slice(4));
    const letras = new Set(sufijos.join(''));
    expect(letras.size).toBeGreaterThan(15);
  });

  test('un código inventado, mal formado o vacío no inscribe y responde siempre igual', async ({ nucleo }) => {
    const { id, codigo } = await cursoConCodigo(nucleo);
    const c = await cuentaNueva(nucleo);
    const respuestas = new Set<string>();
    for (const intento of ['CCX-AAAAAA', `${codigo}X`, codigo.slice(0, -1), '', '   ', 'cc-', "CCX-' OR 1=1 --", codigo.replace('-', '')]) {
      const r = await c.post('/api/unirse', { codigo: intento });
      expect(r.status, intento).toBe(400);
      expect(r.json.error).toBe('codigo_invalido');
      respuestas.add(JSON.stringify(r.json));
    }
    const tipo = await c.post('/api/unirse', { codigo: 123456 });
    expect(tipo.status).toBe(400);
    expect(respuestas.size).toBe(1);
    expect((await c.get('/api/mis-cursos')).json.cursos.map((x: any) => x.id)).not.toContain(id);
  });

  test('adivinar códigos se corta por persona aunque después acierte', async ({ nucleo }) => {
    const { id, codigo } = await cursoConCodigo(nucleo);
    const c = await cuentaNueva(nucleo);
    for (let i = 0; i < 10; i++) {
      const r = await c.post('/api/unirse', { codigo: `CCX-${'ABCDEFGHJK'[i]}${'AAAAA'}` });
      expect(r.status, `intento ${i + 1}`).toBe(400);
    }
    const bloqueado = await c.post('/api/unirse', { codigo });
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.json.error).toBe('demasiados_intentos');
    expect((await c.get('/api/mis-cursos')).json.cursos.map((x: any) => x.id)).not.toContain(id);
    const otra = await cuentaNueva(nucleo);
    expect((await otra.post('/api/unirse', { codigo })).status).toBe(200);
  });

  test('adivinar códigos desde muchas cuentas se corta por IP', async ({ nucleo }) => {
    const { codigo } = await cursoConCodigo(nucleo);
    const ip = `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
    let fallos = 0;
    for (let cuenta = 0; cuenta < 4 && fallos < 30; cuenta++) {
      const c = await cuentaNueva(nucleo, ip);
      for (let i = 0; i < 9 && fallos < 30; i++) {
        const r = await c.post('/api/unirse', { codigo: `CCX-${'ABCDEFGHJ'[i]}${'BBBBB'}` });
        expect(r.status).toBe(400);
        fallos++;
      }
    }
    const ultima = await cuentaNueva(nucleo, ip);
    const r = await ultima.post('/api/unirse', { codigo });
    expect(r.status).toBe(429);
  });

  test('códigos inactivos, vencidos o regenerados no sirven', async ({ nucleo }) => {
    const { profe, id, codigo } = await cursoConCodigo(nucleo);
    expect((await profe.put(`/api/cursos/${id}/codigo`, { activo: false })).status).toBe(200);
    const a = await sesion(nucleo, ALUMNO_AUSTRAL);
    expect((await a.post('/api/unirse', { codigo })).json.error).toBe('codigo_invalido');
    expect((await profe.put(`/api/cursos/${id}/codigo`, { activo: true })).status).toBe(200);
    ejecutarSql(nucleo, 'UPDATE codigos_curso SET vence_en = ? WHERE curso_id = ?', new Date(Date.now() - 60_000).toISOString(), id);
    const v = await a.post('/api/unirse', { codigo });
    expect(v.status).toBe(400);
    expect(v.json.error).toBe('codigo_invalido');
    const nuevo = (await profe.post(`/api/cursos/${id}/codigo`, {})).json.codigo;
    expect((await a.post('/api/unirse', { codigo })).status).toBe(400);
    expect(inscripto(nucleo, id, ALUMNO_AUSTRAL)).toBe(false);
    expect((await a.post('/api/unirse', { codigo: nuevo })).status).toBe(200);
  });

  test('los días de vigencia se validan', async ({ nucleo }) => {
    const { profe, id } = await cursoConCodigo(nucleo);
    for (const dias of [0, -1, 366, 1.5, 'diez', 100000]) {
      const r = await profe.post(`/api/cursos/${id}/codigo`, { dias });
      expect(r.status, String(dias)).toBe(400);
    }
  });

  test('el código de un curso no sirve para gente de otra universidad ni para el owner', async ({ nucleo }) => {
    const { id, codigo } = await cursoConCodigo(nucleo);
    for (const email of [ALUMNO_DEMO, PROFE_DEMO, OWNER]) {
      const c = await sesion(nucleo, email);
      const r = await c.post('/api/unirse', { codigo });
      expect(r.status, email).toBe(400);
      expect(r.json.error).toBe('codigo_invalido');
      expect(inscripto(nucleo, id, email)).toBe(false);
    }
    const demo = await cursoConCodigo(nucleo, PROFE_DEMO);
    const austral = await sesion(nucleo, ALUMNA2_AUSTRAL);
    expect((await austral.post('/api/unirse', { codigo: demo.codigo })).status).toBe(400);
    expect(inscripto(nucleo, demo.id, ALUMNA2_AUSTRAL)).toBe(false);
  });

  test('unirse con código siempre da rol de alumno, aunque se pida otro', async ({ nucleo }) => {
    const { id, codigo } = await cursoConCodigo(nucleo);
    const c = await sesion(nucleo, SIN_MARCA_AUSTRAL);
    const r = await c.post('/api/unirse', { codigo, rol: 'dueño', curso: 'redes' });
    expect(r.status).toBe(200);
    expect(r.json.curso).toMatchObject({ id, rol: 'alumno' });
    expect(inscripto(nucleo, 'redes', SIN_MARCA_AUSTRAL)).toBe(false);
  });

  test('sin sesión no se usa el código y con token hace falta cursos:escribir', async ({ nucleo }) => {
    const { codigo } = await cursoConCodigo(nucleo);
    const anon = new Cliente(nucleo);
    expect((await anon.post('/api/unirse', { codigo })).status).toBe(401);
    const c = await sesion(nucleo, ALUMNA2_AUSTRAL);
    const sinOrigen = await c.post('/api/unirse', { codigo }, { origen: 'http://evil.com' });
    expect(sinOrigen.status).toBe(403);
  });
});
