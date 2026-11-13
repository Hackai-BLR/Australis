import fs from 'node:fs';
import path from 'node:path';
import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL, SIN_MARCA_AUSTRAL, ADMIN_AUSTRAL, OWNER } from '../fixtures.ts';
import { reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { docker } from '../lib/docker.ts';
import { crearCurso, idAleatorio, sesion } from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ timeout: 300_000 });

const RESERVADOS = [
  'www', 'api', 'admin', 'administracion', 'owner', 'app', 'mail', 'correo', 'smtp', 'imap', 'pop', 'ftp', 'static', 'estaticos',
  'cdn', 'assets', 'login', 'auth', 'cuenta', 'cuentas', 'soporte', 'ayuda', 'docs', 'blog', 'status', 'estado', 'salud', 'campus',
  'campusia', 'plataforma', 'nucleo', 'curso', 'cursos', 'prueba', 'pruebas', 'test', 'dev', 'staging', 'root', 'sistema',
];

const RAROS = [
  'redes-curso', 'algo-prueba', 'x-curso', 'mi-curso-curso', 'Redes', 'REDES2', 'a.b', 'a_b', '-abc', 'abc-', 'ab', 'a', '',
  'a--b', 'ñandu', 'análisis', 'redes ii', 'redes/ii', '../etc', '..', '.', 'a%2eb', 'redes%00', 'redes\u0000x', 'xn--nand-iqa',
  'rеdes', 'a'.repeat(41), 'curso;rm -rf', '$(id)', '`id`', 'a\nb', '*', 'redes.campusia.prueba', 'http://x',
];

function nadaCreado(nucleo: any, id: string) {
  expect(nucleo.consultar('SELECT COUNT(*) AS n FROM cursos WHERE id = ?', id)[0].n, `curso ${JSON.stringify(id)}`).toBe(0);
  if (id.includes('\u0000')) {
    const r = docker(['ps', '-a', '--filter', `label=campusia.prefijo=${nucleo.prefijo}`, '--format', '{{.Label "campusia.curso"}}'], true);
    expect(r.salida.split('\n').filter((l) => l === id || l.includes('\u0000')), `contenedor ${JSON.stringify(id)}`).toEqual([]);
    return;
  }
  const r = docker(['ps', '-aq', '--filter', `label=campusia.prefijo=${nucleo.prefijo}`, '--filter', `label=campusia.curso=${id}`], true);
  expect(r.salida, `contenedor ${JSON.stringify(id)}`).toBe('');
}

test.describe('subdominios de cursos', () => {
  test('las palabras reservadas no se pueden usar', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    for (const id of RESERVADOS) {
      const r = await crearCurso(profe, { id });
      expect(r.status, id).toBe(400);
      expect(r.json.error).toBe('subdominio_invalido');
      nadaCreado(nucleo, id);
    }
  });

  test('los sufijos de la plataforma y los caracteres raros se rechazan sin crear nada', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const antes = fs.readdirSync(nucleo.raizCursos).sort();
    for (const id of RAROS) {
      const r = await crearCurso(profe, { id });
      expect(r.status, JSON.stringify(id)).toBe(400);
      expect(r.json.error, JSON.stringify(id)).toBe('subdominio_invalido');
      nadaCreado(nucleo, id);
    }
    const tipos = [123, null, ['abc'], { id: 'abc' }];
    for (const sub of tipos) {
      const r = await profe.post('/api/cursos', { nombre: 'X', subdominio: sub, periodo: 'Anual 2027' });
      expect(r.status, JSON.stringify(sub)).toBe(400);
    }
    expect(fs.readdirSync(nucleo.raizCursos).sort()).toEqual(antes);
    expect(fs.existsSync(path.join(nucleo.raizCursos, '..', 'etc'))).toBe(false);
  });

  test('los límites de largo valen en los dos extremos', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const largo = `l${Date.now().toString(36)}${'0'.repeat(40)}`.slice(0, 40);
    expect(largo.length).toBe(40);
    expect((await crearCurso(profe, { id: largo })).status).toBe(201);
    const corto = `z${Math.random().toString(36).slice(2, 4)}`;
    expect((await crearCurso(profe, { id: corto })).status).toBe(201);
  });

  test('un subdominio en uso no se puede volver a tomar', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('dup');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    const otra = await sesion(nucleo, 'dherrera@austral.edu.ar');
    for (const intento of [id, ` ${id} `]) {
      const r = await crearCurso(otra, { id: intento });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('subdominio_en_uso');
    }
    for (const sembrado of ['redes', 'quimica']) {
      expect((await crearCurso(otra, { id: sembrado })).status).toBe(409);
    }
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.map((i: any) => [i.email, i.rol])).toEqual([[PROFE_AUSTRAL, 'dueño']]);
  });

  test('sin marca de profesor no se crean cursos', async ({ nucleo }) => {
    for (const email of [ALUMNO_AUSTRAL, SIN_MARCA_AUSTRAL, ADMIN_AUSTRAL, OWNER]) {
      const c = await sesion(nucleo, email);
      const id = idAleatorio('nm');
      const r = await crearCurso(c, { id });
      expect(r.status, email).toBe(403);
      expect(r.json.error).toBe('prohibido');
      nadaCreado(nucleo, id);
    }
    const anon = new Cliente(nucleo);
    expect((await crearCurso(anon, { id: idAleatorio('an') })).status).toBe(401);
  });

  test('nombre y período se validan', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    for (const [nombre, periodo] of [['', 'Anual'], ['   ', 'Anual'], ['x'.repeat(121), 'Anual'], ['Bien', ''], ['Bien', 'p'.repeat(61)], [null, 'Anual']]) {
      const id = idAleatorio('val');
      const r = await profe.post('/api/cursos', { nombre, subdominio: id, periodo });
      expect(r.status, `${nombre} ${periodo}`).toBe(400);
      expect(r.json.error).toBe('datos_invalidos');
      nadaCreado(nucleo, id);
    }
  });

  test('las marcas y la universidad no salen del cuerpo', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('cmp');
    const r = await profe.post('/api/cursos', { nombre: 'X', subdominio: id, periodo: 'Anual', universidad_id: 2, dueno: 1, color: 'red', estado: 'listo', version_publicada: 99 });
    expect(r.status).toBe(201);
    const fila = nucleo.consultar('SELECT c.universidad_id, c.version_publicada, u.nombre FROM cursos c JOIN universidades u ON u.id = c.universidad_id WHERE c.id = ?', id)[0];
    expect(fila.nombre).toBe('Universidad Austral');
    expect(fila.version_publicada).toBeNull();
    expect(r.json.color).not.toBe('red');
  });

  test('crear cursos con Origin de un curso o de otro sitio se rechaza', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    for (const origen of [`http://redes-curso.campusia.prueba:${nucleo.puerto}`, 'http://evil.com', null]) {
      const id = idAleatorio('org');
      const r = await crearCurso(profe, { id }, { origen });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('origen_invalido');
      nadaCreado(nucleo, id);
    }
  });
});
