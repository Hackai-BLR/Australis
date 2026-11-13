import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  archivoCursos, cuerpoMensaje, dirTemporal, levantarIntermediario, pedir, tokenCurso, tokenRealFalso,
} from '../lib/comun.mjs'
import { crearUpstreamFalso } from '../lib/upstream-falso.mjs'

describe('aceptación: el intermediario reenvía con la credencial real', () => {
  let dir, upstream, inter, real, cursoA, cursoB

  before(async () => {
    dir = dirTemporal()
    real = tokenRealFalso(dir)
    cursoA = { curso: 'curso-a', token: tokenCurso() }
    cursoB = { curso: 'curso-b', token: tokenCurso() }
    upstream = await crearUpstreamFalso()
    inter = await levantarIntermediario({
      dir,
      tokenArchivo: real.ruta,
      cursosArchivo: archivoCursos(dir, [cursoA, cursoB]),
      registro: path.join(dir, 'registro.jsonl'),
      destino: upstream.url,
    })
  })

  after(async () => {
    if (inter) await inter.detener()
    if (upstream) await upstream.cerrar()
  })

  it('GET /salud responde 200 sin credencial y no se reenvía', async () => {
    const antes = upstream.recibidas.length
    const r = await pedir(inter.url, { path: '/salud' })
    assert.equal(r.estado, 200)
    assert.deepEqual(JSON.parse(r.cuerpo), { estado: 'ok' })
    assert.equal(upstream.recibidas.length, antes)
  })

  it('Authorization: Bearer con token de curso se reemplaza por el token real', async () => {
    const antes = upstream.recibidas.length
    const cuerpo = JSON.stringify(cuerpoMensaje())
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages?beta=true',
      headers: {
        authorization: `Bearer ${cursoA.token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/9.9.9 (external, cli)',
        'x-app': 'cli',
      },
      body: cuerpo,
    })
    assert.equal(r.estado, 200)
    assert.equal(JSON.parse(r.cuerpo).content[0].text, 'ok')
    assert.equal(upstream.recibidas.length, antes + 1)
    const rec = upstream.recibidas.at(-1)
    assert.equal(rec.metodo, 'POST')
    assert.equal(rec.ruta, '/v1/messages')
    assert.equal(rec.query, '?beta=true')
    assert.equal(rec.cuerpo, cuerpo)
    assert.equal(rec.headers.authorization, `Bearer ${real.valor}`)
    assert.equal(rec.headers['x-api-key'], undefined)
    assert.equal(rec.headers['anthropic-version'], '2023-06-01')
    assert.equal(rec.headers['user-agent'], 'claude-cli/9.9.9 (external, cli)')
    assert.equal(rec.headers['x-app'], 'cli')
    const betas = String(rec.headers['anthropic-beta'] || '').split(',').map(s => s.trim())
    assert.ok(betas.includes('oauth-2025-04-20'), `anthropic-beta recibido: ${rec.headers['anthropic-beta']}`)
  })

  it('x-api-key con token de curso también se acepta y se reemplaza', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': cursoB.token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: cuerpoMensaje(),
    })
    assert.equal(r.estado, 200)
    const rec = upstream.recibidas.at(-1)
    assert.equal(rec.headers.authorization, `Bearer ${real.valor}`)
    assert.equal(rec.headers['x-api-key'], undefined)
  })

  it('conserva los anthropic-beta del cliente y agrega el de suscripción sin duplicarlo', async () => {
    await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json', 'anthropic-beta': 'prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14' },
      body: cuerpoMensaje(),
    })
    let betas = String(upstream.recibidas.at(-1).headers['anthropic-beta']).split(',').map(s => s.trim())
    assert.ok(betas.includes('prompt-caching-2024-07-31'))
    assert.ok(betas.includes('fine-grained-tool-streaming-2025-05-14'))
    assert.equal(betas.filter(b => b === 'oauth-2025-04-20').length, 1)

    await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      body: cuerpoMensaje(),
    })
    betas = String(upstream.recibidas.at(-1).headers['anthropic-beta']).split(',').map(s => s.trim())
    assert.equal(betas.filter(b => b === 'oauth-2025-04-20').length, 1)
  })

  it('el streaming SSE llega a medida que se produce', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages?lento=1',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' },
      body: cuerpoMensaje({ stream: true }),
    })
    assert.equal(r.estado, 200)
    assert.match(String(r.headers['content-type']), /text\/event-stream/)
    const primero = r.tiempos.find(t => t.texto.includes('message_start'))
    assert.ok(primero, 'no llegó message_start')
    assert.ok(primero.ms < 1000, `message_start llegó a los ${primero.ms} ms: el intermediario está acumulando la respuesta`)
    assert.ok(r.total >= 1400, `la respuesta terminó a los ${r.total} ms`)
    assert.ok(r.cuerpo.includes('message_stop'))
  })

  it('devuelve el estado y los encabezados de error del destino', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages?estado=429',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' },
      body: cuerpoMensaje(),
    })
    assert.equal(r.estado, 429)
    assert.equal(r.headers['retry-after'], '7')
    assert.equal(JSON.parse(r.cuerpo).error.type, 'rate_limit_error')
  })

  it('reenvía GET de otras rutas bajo /v1/', async () => {
    const r = await pedir(inter.url, { path: '/v1/models?limit=5', headers: { authorization: `Bearer ${cursoA.token}` } })
    assert.equal(r.estado, 200)
    const rec = upstream.recibidas.at(-1)
    assert.equal(rec.metodo, 'GET')
    assert.equal(rec.ruta, '/v1/models')
    assert.equal(rec.query, '?limit=5')
    assert.equal(rec.headers.authorization, `Bearer ${real.valor}`)
  })

  it('POST /v1/messages/count_tokens se reenvía', async () => {
    const r = await pedir(inter.url, {
      method: 'POST',
      path: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' },
      body: cuerpoMensaje(),
    })
    assert.equal(r.estado, 200)
    assert.equal(upstream.recibidas.at(-1).ruta, '/v1/messages/count_tokens')
  })

  it('el destino recibe su propio Host', async () => {
    await pedir(inter.url, { path: '/v1/models', headers: { authorization: `Bearer ${cursoA.token}` } })
    assert.equal(upstream.recibidas.at(-1).headers.host, `127.0.0.1:${upstream.puerto}`)
  })
})
