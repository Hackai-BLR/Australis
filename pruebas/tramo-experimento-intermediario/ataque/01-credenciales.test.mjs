import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  archivoCursos, contieneSecreto, cuerpoMensaje, dirTemporal, esperar, leerRegistro, levantarIntermediario, pedir, tokenCurso, tokenRealFalso,
} from '../lib/comun.mjs'
import { crearUpstreamFalso } from '../lib/upstream-falso.mjs'

describe('ataque: credenciales falsas, robadas o mezcladas', () => {
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

  async function rechazada(headers, ruta = '/v1/messages') {
    const antes = upstream.recibidas.length
    const r = await pedir(inter.url, { method: 'POST', path: ruta, headers: { 'content-type': 'application/json', ...headers }, body: cuerpoMensaje() })
    assert.equal(r.estado, 401, `se esperaba 401 y vino ${r.estado}: ${r.cuerpo}`)
    const json = JSON.parse(r.cuerpo)
    assert.equal(json.type, 'error')
    assert.equal(json.error.type, 'authentication_error')
    assert.equal(upstream.recibidas.length, antes, 'la petición se reenvió al destino')
    assert.ok(!contieneSecreto(r.cuerpo, real.valor))
    return r
  }

  it('sin credencial se rechaza sin reenviar', async () => {
    await rechazada({})
  })

  it('un token de curso inventado se rechaza', async () => {
    await rechazada({ authorization: `Bearer ${tokenCurso()}` })
    await rechazada({ 'x-api-key': tokenCurso() })
  })

  it('prefijos, sufijos y variantes de un token válido se rechazan', async () => {
    await rechazada({ authorization: `Bearer ${cursoA.token.slice(0, -1)}` })
    await rechazada({ authorization: `Bearer ${cursoA.token}x` })
    await rechazada({ authorization: `Bearer ${cursoA.token.toUpperCase()}` })
    await rechazada({ authorization: `Bearer curso-` })
    await rechazada({ authorization: 'Bearer curso-a' })
    await rechazada({ authorization: cursoA.token })
    await rechazada({ authorization: `Basic ${Buffer.from(`x:${cursoA.token}`).toString('base64')}` })
  })

  it('el propio token real no sirve como credencial de curso', async () => {
    await rechazada({ authorization: `Bearer ${real.valor}` })
    await rechazada({ 'x-api-key': real.valor })
  })

  it('una clave de API ajena no se deja pasar al destino', async () => {
    await rechazada({ 'x-api-key': 'sk-ant-api03-ATACANTE-0000000000000000000000' })
    await rechazada({ authorization: 'Bearer sk-ant-oat01-ATACANTE-000000000000000000000' })
  })

  it('dos credenciales a la vez se rechazan aunque una sea válida', async () => {
    await rechazada({ authorization: `Bearer ${cursoA.token}`, 'x-api-key': 'sk-ant-api03-ATACANTE-0000000000000000000000' })
    await rechazada({ authorization: `Bearer ${cursoA.token}`, 'x-api-key': cursoB.token })
  })

  it('el destino no recibe cookies ni credenciales del cliente', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: `Bearer ${cursoA.token}`, cookie: 'sessionKey=sk-ant-sid01-ATACANTE', 'content-type': 'application/json' },
      body: cuerpoMensaje(),
    })
    assert.equal(r.estado, 200)
    const rec = upstream.recibidas.at(-1)
    assert.equal(rec.headers.cookie, undefined)
    assert.equal(rec.headers['x-api-key'], undefined)
    assert.equal(rec.headers.authorization, `Bearer ${real.valor}`)
    const auths = []
    for (let i = 0; i < rec.rawHeaders.length; i += 2) if (rec.rawHeaders[i].toLowerCase() === 'authorization') auths.push(rec.rawHeaders[i + 1])
    assert.equal(auths.length, 1)
    assert.ok(!JSON.stringify(rec.headers).includes(cursoA.token), 'el token del curso llegó al destino')
  })

  it('el curso no se puede falsificar con encabezados', async () => {
    await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: `Bearer ${cursoA.token}`, 'x-curso': 'curso-b', 'x-campus-curso': 'curso-b', 'content-type': 'application/json' },
      body: cuerpoMensaje({ model: 'claude-haiku-falsificado' }),
    })
    await esperar(500)
    const lineas = leerRegistro(registro).filter(l => l.modelo === 'claude-haiku-falsificado')
    assert.equal(lineas.length, 1)
    assert.equal(lineas[0].curso, 'curso-a')
  })

  it('el token real nunca vuelve al cliente aunque el destino lo refleje', async () => {
    const r = await pedir(inter.url, { method: 'POST', path: '/v1/eco', headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.estado, 200)
    assert.ok(!contieneSecreto(r.cuerpo, real.valor), 'el token real apareció en el cuerpo de la respuesta')
    assert.ok(!contieneSecreto(JSON.stringify(r.rawHeaders), real.valor), 'el token real apareció en los encabezados de la respuesta')
  })

  it('el token real nunca vuelve al cliente aunque llegue partido en dos trozos de un stream', async () => {
    const r = await pedir(inter.url, { method: 'POST', path: '/v1/eco-stream', headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.estado, 200)
    assert.ok(!contieneSecreto(r.cuerpo, real.valor), 'el token real apareció en el stream de la respuesta')
  })

  it('ni el registro ni la salida del intermediario contienen el token real ni los de curso', async () => {
    await esperar(300)
    const textos = [fs.readFileSync(registro, 'utf8'), fs.readFileSync(inter.salida, 'utf8')]
    for (const t of textos) {
      assert.ok(!contieneSecreto(t, real.valor), 'el token real apareció en un registro')
      assert.ok(!t.includes(cursoA.token) && !t.includes(cursoB.token), 'un token de curso apareció en un registro')
    }
  })
})
