import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  archivoCursos, cuerpoMensaje, dirTemporal, esperarRegistro, leerRegistro, levantarIntermediario, pedir, tokenCurso, tokenRealFalso,
} from '../lib/comun.mjs'
import { crearUpstreamFalso } from '../lib/upstream-falso.mjs'

describe('aceptación: el intermediario registra el uso por curso', () => {
  let dir, upstream, inter, real, cursoA, cursoB, registro

  before(async () => {
    dir = dirTemporal()
    real = tokenRealFalso(dir)
    cursoA = { curso: 'curso-a', token: tokenCurso() }
    cursoB = { curso: 'curso-b', token: tokenCurso() }
    registro = path.join(dir, 'registro.jsonl')
    upstream = await crearUpstreamFalso()
    inter = await levantarIntermediario({
      dir,
      tokenArchivo: real.ruta,
      cursosArchivo: archivoCursos(dir, [cursoA, cursoB]),
      registro,
      destino: upstream.url,
    })
  })

  after(async () => {
    if (inter) await inter.detener()
    if (upstream) await upstream.cerrar()
  })

  it('registra los tokens de una respuesta JSON', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' },
      body: cuerpoMensaje({ model: 'claude-haiku-json' }),
    })
    assert.equal(r.estado, 200)
    const linea = await esperarRegistro(registro, l => l.curso === 'curso-a' && l.modelo === 'claude-haiku-json')
    assert.ok(linea, `no apareció la línea de uso: ${JSON.stringify(leerRegistro(registro))}`)
    assert.equal(linea.metodo, 'POST')
    assert.equal(linea.ruta, '/v1/messages')
    assert.equal(linea.estado, 200)
    assert.equal(linea.reenviada, true)
    assert.equal(linea.tokens_entrada, 11)
    assert.equal(linea.tokens_salida, 7)
    assert.equal(linea.tokens_cache_creacion, 2)
    assert.equal(linea.tokens_cache_lectura, 5)
    assert.ok(!Number.isNaN(Date.parse(linea.momento)), 'momento no es una fecha ISO 8601')
  })

  it('registra los tokens de una respuesta en streaming', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': cursoB.token, 'content-type': 'application/json' },
      body: cuerpoMensaje({ model: 'claude-haiku-sse', stream: true }),
    })
    assert.equal(r.estado, 200)
    const linea = await esperarRegistro(registro, l => l.curso === 'curso-b' && l.modelo === 'claude-haiku-sse')
    assert.ok(linea, `no apareció la línea de uso: ${JSON.stringify(leerRegistro(registro))}`)
    assert.equal(linea.estado, 200)
    assert.equal(linea.reenviada, true)
    assert.equal(linea.tokens_entrada, 25)
    assert.equal(linea.tokens_salida, 9)
    assert.equal(linea.tokens_cache_creacion, 4)
    assert.equal(linea.tokens_cache_lectura, 3)
  })

  it('registra también las respuestas de error del destino', async () => {
    await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages?estado=429',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' },
      body: cuerpoMensaje(),
    })
    const linea = await esperarRegistro(registro, l => l.curso === 'curso-a' && l.estado === 429)
    assert.ok(linea)
    assert.equal(linea.reenviada, true)
    assert.equal(linea.ruta, '/v1/messages')
  })

  it('cada línea del registro es JSON con los campos del contrato', async () => {
    const lineas = leerRegistro(registro)
    assert.ok(lineas.length >= 3)
    for (const l of lineas) {
      for (const campo of ['momento', 'curso', 'metodo', 'ruta', 'estado', 'reenviada', 'modelo', 'tokens_entrada', 'tokens_salida', 'tokens_cache_creacion', 'tokens_cache_lectura']) {
        assert.ok(campo in l, `falta ${campo} en ${JSON.stringify(l)}`)
      }
    }
  })
})
