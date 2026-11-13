import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificarIdentidad, ErrorIdentidad, type CodigoErrorIdentidad } from '../dist/index.js';
import { b64url, carga, firmar, firmarCadena, nuevoPar, T } from './ayudas.ts';

const par = nuevoPar();
const otro = nuevoPar();
const base = { clavePublica: par.publica, curso: 'redes', ahora: T + 10 };

function codigoDe(fn: () => unknown): CodigoErrorIdentidad {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ErrorIdentidad);
    assert.equal(error.name, 'ErrorIdentidad');
    return error.codigo;
  }
  assert.fail('se esperaba ErrorIdentidad');
}

function rechazo(encabezado: string | null | undefined, opciones: Partial<typeof base> = {}): CodigoErrorIdentidad {
  return codigoDe(() => verificarIdentidad(encabezado, { ...base, ...opciones }));
}

test('acepta una identidad válida y devuelve solo los 8 campos', () => {
  const id = verificarIdentidad(firmar(carga({ extra: 'x', rol: 'dueño', nombre: 'Íñigo Peña' }), par.privada), base);
  assert.deepEqual({ ...id }, {
    v: 1,
    curso: 'redes',
    usuario: 'u-alumno-1',
    email: 'ana.gomez@austral.edu.ar',
    nombre: 'Íñigo Peña',
    rol: 'dueño',
    emitido: T,
    vence: T + 60,
  });
});

test('es sincrónica', () => {
  const r = verificarIdentidad(firmar(carga(), par.privada), base);
  assert.equal(typeof (r as unknown as { then?: unknown }).then, 'undefined');
});

test('usa el reloj real si no se pasa ahora', () => {
  const t = Math.floor(Date.now() / 1000);
  const id = verificarIdentidad(firmar(carga({ emitido: t, vence: t + 120 }), par.privada), { clavePublica: par.publica, curso: 'redes' });
  assert.equal(id.emitido, t);
});

test('configuración inválida', () => {
  const enc = firmar(carga(), par.privada);
  for (const clave of ['', 'corta', b64url(Buffer.alloc(31)), b64url(Buffer.alloc(33)), `${par.publica}=`, `${par.publica.slice(0, -1)}+`]) {
    assert.equal(rechazo(enc, { clavePublica: clave }), 'configuracion', clave);
  }
  assert.equal(rechazo(enc, { curso: '' }), 'configuracion');
  assert.equal(rechazo(undefined, { curso: '' }), 'configuracion');
  assert.equal(rechazo(enc, { ahora: Number.NaN }), 'configuracion');
});

test('ausente', () => {
  assert.equal(rechazo(undefined), 'ausente');
  assert.equal(rechazo(null), 'ausente');
  assert.equal(rechazo(''), 'ausente');
});

test('formato del encabezado', () => {
  const [c, f] = firmar(carga(), par.privada).split('.') as [string, string];
  assert.equal(rechazo('sin-punto'), 'formato');
  assert.equal(rechazo(`${c}.${f}.x`), 'formato');
  assert.equal(rechazo(`.${f}`), 'formato');
  assert.equal(rechazo(`${c}.`), 'formato');
  assert.equal(rechazo(`${c}.${f.slice(0, -2)}`), 'formato');
  assert.equal(rechazo(`${c}=.${f}`), 'formato');
  assert.equal(rechazo(`Bearer ${c}.${f}`), 'formato');
  assert.equal(rechazo(`${c}.${f}, ${c}.${f}`), 'formato');
  assert.equal(rechazo(`${'A'.repeat(4100)}.${f}`), 'formato');
  assert.equal(rechazo(`${c}.${b64url(Buffer.alloc(65))}`), 'formato');
});

test('firma', () => {
  const [c, f] = firmar(carga(), par.privada).split('.') as [string, string];
  assert.equal(rechazo(firmar(carga(), otro.privada)), 'firma');
  assert.equal(rechazo(`${c}.${f}`, { clavePublica: otro.publica }), 'firma');
  assert.equal(rechazo(`${c}.${b64url(Buffer.alloc(64))}`), 'firma');
  const alterada = b64url(JSON.stringify(carga({ rol: 'profesor' })));
  assert.equal(rechazo(`${alterada}.${f}`), 'firma');
  const json = JSON.stringify(carga());
  assert.equal(rechazo(`${b64url(json)}.${firmarCadena(json, par.privada)}`), 'firma');
});

test('la firma se verifica antes que el contenido', () => {
  assert.equal(rechazo(firmar(carga({ v: 2, curso: 'otro' }), otro.privada)), 'firma');
  const basura = b64url('no es json');
  assert.equal(rechazo(`${basura}.${firmarCadena(basura, otro.privada)}`), 'firma');
});

test('formato de la carga firmada', () => {
  const noJson = b64url('no es json');
  assert.equal(rechazo(`${noJson}.${firmarCadena(noJson, par.privada)}`), 'formato');
  const utf8Roto = b64url(Buffer.from([0x7b, 0xff, 0x7d]));
  assert.equal(rechazo(`${utf8Roto}.${firmarCadena(utf8Roto, par.privada)}`), 'formato');
  for (const campo of ['v', 'curso', 'usuario', 'email', 'nombre', 'rol', 'emitido', 'vence']) {
    const c = carga();
    delete c[campo];
    assert.equal(rechazo(firmar(c, par.privada)), 'formato', campo);
  }
  for (const [campo, valor] of [
    ['curso', 1], ['usuario', null], ['email', ['a']], ['nombre', {}],
    ['emitido', String(T)], ['vence', T + 0.5], ['emitido', null],
  ] as const) {
    assert.equal(rechazo(firmar(carga({ [campo]: valor }), par.privada)), 'formato', campo);
  }
  for (const rol of ['admin', 'Profesor', 'duenio', '', 'dueño ']) {
    assert.equal(rechazo(firmar(carga({ rol }), par.privada)), 'formato', rol);
  }
  assert.equal(rechazo(firmar([carga()], par.privada)), 'formato');
  assert.equal(rechazo(firmar(null, par.privada)), 'formato');
  assert.equal(rechazo(firmar('texto', par.privada)), 'formato');
});

test('versión', () => {
  assert.equal(rechazo(firmar(carga({ v: 2 }), par.privada)), 'version');
  assert.equal(rechazo(firmar(carga({ v: 0 }), par.privada)), 'version');
  assert.equal(rechazo(firmar(carga({ v: '1' }), par.privada)), 'formato');
  assert.equal(rechazo(firmar(carga({ v: 2, curso: 'otro' }), par.privada)), 'version');
});

test('curso', () => {
  for (const curso of ['otro', 'Redes', 'redes ', '']) {
    assert.equal(rechazo(firmar(carga({ curso }), par.privada)), 'curso', curso);
  }
  assert.equal(rechazo(firmar(carga({ curso: 'otro', vence: T + 9999 }), par.privada)), 'curso');
});

test('vigencia', () => {
  assert.equal(rechazo(firmar(carga({ vence: T + 121 }), par.privada)), 'vigencia');
  assert.equal(rechazo(firmar(carga({ vence: T }), par.privada)), 'vigencia');
  assert.equal(rechazo(firmar(carga({ vence: T - 5 }), par.privada)), 'vigencia');
  assert.equal(rechazo(firmar(carga({ vence: T + 121 }), par.privada), { ahora: T + 500 }), 'vigencia');
  assert.equal(verificarIdentidad(firmar(carga({ vence: T + 120 }), par.privada), base).vence, T + 120);
});

test('vencido', () => {
  const enc = firmar(carga({ vence: T + 60 }), par.privada);
  assert.equal(rechazo(enc, { ahora: T + 60 }), 'vencido');
  assert.equal(rechazo(enc, { ahora: T + 61 }), 'vencido');
  assert.equal(verificarIdentidad(enc, { ...base, ahora: T + 59 }).usuario, 'u-alumno-1');
});

test('futuro con 30 segundos de tolerancia', () => {
  const enc = firmar(carga(), par.privada);
  assert.equal(verificarIdentidad(enc, { ...base, ahora: T - 30 }).emitido, T);
  assert.equal(rechazo(enc, { ahora: T - 31 }), 'futuro');
});
