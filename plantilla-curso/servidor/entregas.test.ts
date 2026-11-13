import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorApi } from '@campusia/sdk';
import { armar, identidadDe, nuevoParDeClaves } from './prueba-utiles.ts';
import { disposicion, tipoPorNombre } from './entregas.ts';

function formulario(campos: Record<string, string | File>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.append(k, v);
  return f;
}

test('el alumno entrega con archivo: se sube, se entrega y la identidad pasa tal cual', async () => {
  const { pedir, par, plataforma } = armar();
  const identidad = identidadDe('alumno', par.privada);
  const res = await pedir('/api/entregas', {
    method: 'POST',
    headers: { 'X-Campus-Identidad': identidad },
    body: formulario({ actividad: 'tp1', texto: 'Mi entrega', archivo: new File(['hola'], 'tp1.txt', { type: 'text/plain' }) }),
  });
  assert.equal(res.status, 201);
  const entrega = (await res.json()) as { actividad: string; texto: string; archivo: { nombre: string; id: string } };
  assert.equal(entrega.actividad, 'tp1');
  assert.equal(entrega.texto, 'Mi entrega');
  assert.equal(entrega.archivo.nombre, 'tp1.txt');
  assert.deepEqual(plataforma.llamadas.map((l) => l.metodo), ['subirArchivo', 'entregar']);
  assert.ok(plataforma.llamadas.every((l) => l.identidad === identidad));
  assert.deepEqual(plataforma.llamadas[1]!.datos, { actividad: 'tp1', texto: 'Mi entrega', archivoId: entrega.archivo.id });
});

test('entrega solo con texto y validaciones del formulario', async () => {
  const { pedir, plataforma } = armar();
  const ok = await pedir('/api/entregas', { persona: 'alumno', method: 'POST', body: formulario({ actividad: 'tp2', texto: 'Solo texto' }) });
  assert.equal(ok.status, 201);
  assert.deepEqual(plataforma.llamadas.map((l) => l.metodo), ['entregar']);
  const casos: Record<string, string>[] = [{ actividad: 'tp2', texto: '   ' }, { actividad: '../x', texto: 'a' }, { texto: 'a' }];
  for (const campos of casos) {
    const r = await pedir('/api/entregas', { persona: 'alumno', method: 'POST', body: formulario(campos) });
    assert.equal(r.status, 400, JSON.stringify(campos));
    assert.deepEqual(await r.json(), { error: 'datos_invalidos' });
  }
  const json = await pedir('/api/entregas', { persona: 'alumno', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"actividad":"tp1","texto":"a"}' });
  assert.equal(json.status, 415);
  assert.equal(plataforma.llamadas.length, 1);
});

test('lista de entregas y notas con la identidad del pedido', async () => {
  const { pedir, plataforma } = armar();
  await pedir('/api/entregas', { persona: 'alumno', method: 'POST', body: formulario({ actividad: 'tp1', texto: 'x' }) });
  const e = await pedir('/api/entregas', { persona: 'profesor' });
  assert.equal(e.status, 200);
  assert.equal(e.headers.get('cache-control'), 'no-store');
  assert.equal(((await e.json()) as { entregas: unknown[] }).entregas.length, 1);
  const n = await pedir('/api/notas', { persona: 'alumno' });
  assert.deepEqual(await n.json(), { notas: [] });
  assert.deepEqual(plataforma.llamadas.map((l) => l.metodo), ['entregar', 'entregas', 'notas']);
});

test('los docentes ponen notas y ven el historial; los alumnos no', async () => {
  const { pedir, plataforma } = armar();
  const poner = (persona: 'alumno' | 'profesor' | 'duenio', cuerpo: unknown) =>
    pedir('/api/notas', { persona, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  assert.equal((await poner('profesor', { usuario: 'u-alumno-1', actividad: 'tp1', valor: '6' })).status, 201);
  const segunda = await poner('duenio', { usuario: 'u-alumno-1', actividad: 'tp1', valor: '8', comentario: 'Mejor' });
  assert.equal(segunda.status, 201);
  assert.equal(((await segunda.json()) as { anterior: string }).anterior, '6');
  assert.deepEqual(plataforma.llamadas[1]!.datos, { usuario: 'u-alumno-1', actividad: 'tp1', valor: '8', comentario: 'Mejor' });
  const alumno = await poner('alumno', { usuario: 'u-alumno-1', actividad: 'tp1', valor: '10' });
  assert.equal(alumno.status, 403);
  const h = await pedir('/api/notas/historial', { persona: 'profesor' });
  assert.deepEqual(((await h.json()) as { notas: { valor: string }[] }).notas.map((x) => x.valor), ['6', '8']);
  assert.equal((await pedir('/api/notas/historial', { persona: 'alumno' })).status, 403);
  assert.equal((await poner('profesor', { usuario: 'u-alumno-1', actividad: 'tp1' })).status, 400);
  assert.equal((await poner('profesor', 'no es json')).status, 400);
  assert.equal(plataforma.llamadas.filter((l) => l.metodo === 'ponerNota').length, 2);
});

test('la descarga lleva los encabezados de la plataforma', async () => {
  const { pedir, plataforma } = armar();
  await pedir('/api/entregas', {
    persona: 'alumno',
    method: 'POST',
    body: formulario({ actividad: 'tp1', archivo: new File(['<script>alert(1)</script>'], 'página "1";.html') }),
  });
  const id = [...plataforma.archivosGuardados.keys()][0]!;
  const r = await pedir(`/api/archivos/${id}`, { persona: 'alumno' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="p_gina _1__.html"; filename*=UTF-8''p%C3%A1gina%20%221%22%3B.html`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('content-length'), '25');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(await r.text(), '<script>alert(1)</script>');
  const falta = await pedir(`/api/archivos/${'f'.repeat(32)}`, { persona: 'alumno' });
  assert.equal(falta.status, 404);
  assert.deepEqual(await falta.json(), { error: 'no_encontrado' });
});

test('tipos y nombres de descarga', () => {
  assert.equal(tipoPorNombre('a.PDF'), 'application/pdf');
  assert.equal(tipoPorNombre('a.py'), 'text/plain; charset=utf-8');
  assert.equal(tipoPorNombre('a.svg'), 'application/octet-stream');
  assert.equal(tipoPorNombre('.txt'), 'application/octet-stream');
  assert.equal(disposicion("a'b(c)*.txt"), `attachment; filename="a'b(c)*.txt"; filename*=UTF-8''a%27b%28c%29%2A.txt`);
  assert.doesNotMatch(disposicion('x\r\nSet-Cookie: a=b'), /[\r\n]/);
});

test('los errores de la plataforma se devuelven con su estado y si no responde, 502', async () => {
  const { pedir, plataforma } = armar();
  plataforma.error = new ErrorApi('tipo_no_permitido', 400);
  const r = await pedir('/api/entregas', { persona: 'alumno', method: 'POST', body: formulario({ actividad: 'tp1', archivo: new File(['x'], 'x.exe') }) });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'tipo_no_permitido' });
  plataforma.error = new ErrorApi('identidad_invalida', 401);
  assert.equal((await pedir('/api/notas', { persona: 'alumno' })).status, 401);
  plataforma.error = new ErrorApi('servidor', 500);
  assert.equal((await pedir('/api/entregas', { persona: 'alumno' })).status, 502);
  plataforma.error = null;
  plataforma.caida = true;
  const caida = await pedir('/api/notas', { persona: 'alumno' });
  assert.equal(caida.status, 502);
  assert.deepEqual(await caida.json(), { error: 'plataforma_no_disponible' });
});

test('sin identidad válida no se llega a la plataforma', async () => {
  const { pedir, plataforma } = armar();
  const otro = nuevoParDeClaves();
  for (const ruta of ['/api/entregas', '/api/notas', '/api/notas/historial', `/api/archivos/${'0'.repeat(32)}`]) {
    assert.equal((await pedir(ruta)).status, 401, ruta);
    assert.equal((await pedir(ruta, { headers: { 'X-Campus-Identidad': identidadDe('profesor', otro.privada) } })).status, 401, ruta);
  }
  assert.equal((await pedir('/api/entregas', { method: 'POST', body: formulario({ actividad: 'tp1', texto: 'x' }) })).status, 401);
  assert.equal(plataforma.llamadas.length, 0);
});

test('ninguna ruta edita ni borra entregas o notas', async () => {
  const { pedir, plataforma } = armar();
  for (const [metodo, ruta] of [['PUT', '/api/entregas'], ['DELETE', '/api/entregas'], ['PATCH', '/api/notas'], ['DELETE', '/api/notas/1'], ['POST', '/api/archivos/1']]) {
    assert.equal((await pedir(ruta!, { persona: 'duenio', method: metodo! })).status, 404, `${metodo} ${ruta}`);
  }
  assert.equal(plataforma.llamadas.length, 0);
});
