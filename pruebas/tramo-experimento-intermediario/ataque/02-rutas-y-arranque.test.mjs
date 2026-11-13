import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  archivoCursos, compilarIntermediario, contieneSecreto, cuerpoMensaje, dirTemporal, escribirSecreto, esperar, esperarRegistro,
  lanzarIntermediario, levantarIntermediario, pedir, puertoLibre, tokenCurso, tokenRealFalso,
} from '../lib/comun.mjs'
import { crearUpstreamFalso } from '../lib/upstream-falso.mjs'

describe('ataque: rutas fuera de lo permitido', () => {
  let dir, upstream, inter, real, cursoA, registro, atacante, recibidasAtacante

  before(async () => {
    dir = dirTemporal()
    real = tokenRealFalso(dir)
    cursoA = { curso: 'curso-a', token: tokenCurso() }
    registro = path.join(dir, 'registro.jsonl')
    upstream = await crearUpstreamFalso()
    recibidasAtacante = []
    atacante = http.createServer((req, res) => { recibidasAtacante.push({ url: req.url, headers: req.headers }); res.end('robado') })
    await new Promise(r => atacante.listen(0, '127.0.0.1', r))
    inter = await levantarIntermediario({
      dir,
      tokenArchivo: real.ruta,
      cursosArchivo: archivoCursos(dir, [cursoA]),
      registro,
      destino: upstream.url,
    })
  })

  after(async () => {
    if (inter) await inter.detener()
    if (upstream) await upstream.cerrar()
    if (atacante) { atacante.closeAllConnections(); await new Promise(r => atacante.close(r)) }
  })

  const auth = () => ({ authorization: `Bearer ${cursoA.token}`, 'content-type': 'application/json' })

  async function noReenviada(ruta, estados, method = 'GET') {
    const antes = upstream.recibidas.length
    const r = await pedir(inter.url, { method, path: ruta, headers: auth(), body: ['GET', 'DELETE'].includes(method) ? undefined : cuerpoMensaje() })
    assert.ok(estados.includes(r.estado), `${method} ${ruta}: se esperaba ${estados.join(' o ')} y vino ${r.estado}`)
    assert.equal(upstream.recibidas.length, antes, `${method} ${ruta} se reenvió al destino como ${upstream.recibidas.at(-1)?.url}`)
    assert.ok(!contieneSecreto(r.cuerpo, real.valor))
  }

  it('las rutas fuera de /v1/ no se reenvían', async () => {
    await noReenviada('/api/oauth/profile', [404])
    await noReenviada('/api/oauth/usage', [404])
    await noReenviada('/api/organizations', [404])
    await noReenviada('/', [404])
    await noReenviada('/v1', [404])
    await noReenviada('/v10/messages', [404])
  })

  it('los recorridos de ruta no escapan de /v1/', async () => {
    await noReenviada('/v1/../api/oauth/profile', [400, 404])
    await noReenviada('/v1/%2e%2e/api/oauth/profile', [400, 404])
    await noReenviada('/v1/%2E%2E/api/oauth/profile', [400, 404])
    await noReenviada('/v1/messages/..%2f..%2fapi/oauth/profile', [400, 404])
    await noReenviada('/v1/..%5capi/oauth/profile', [400, 404])
    await noReenviada('//v1/messages', [400, 404])
    await noReenviada('/v1//../api/oauth/profile', [400, 404])
  })

  it('una URL absoluta no lleva la petición a otro servidor', async () => {
    const { port } = atacante.address()
    const r = await pedir(inter.url, { method: 'POST', path: `http://127.0.0.1:${port}/v1/messages`, headers: auth(), body: cuerpoMensaje() })
    await esperar(300)
    assert.equal(recibidasAtacante.length, 0, 'el intermediario mandó la petición a otro servidor')
    assert.ok(!r.cuerpo.includes('robado'))
  })

  it('un Host ajeno no cambia el destino', async () => {
    const { port } = atacante.address()
    await pedir(inter.url, { method: 'POST', path: '/v1/messages', headers: { ...auth(), host: `127.0.0.1:${port}` }, body: cuerpoMensaje() })
    await esperar(300)
    assert.equal(recibidasAtacante.length, 0)
    assert.equal(upstream.recibidas.at(-1).headers.host, `127.0.0.1:${upstream.puerto}`)
  })

  it('métodos que modifican la cuenta no se reenvían', async () => {
    await noReenviada('/v1/files/file_123', [405], 'DELETE')
    await noReenviada('/v1/messages', [405], 'PUT')
    await noReenviada('/v1/messages', [405], 'PATCH')
  })

  it('las peticiones rechazadas quedan en el registro como no reenviadas', async () => {
    const linea = await esperarRegistro(registro, l => l.ruta === '/api/oauth/profile')
    assert.ok(linea)
    assert.equal(linea.reenviada, false)
    assert.equal(linea.estado, 404)
    assert.equal(linea.curso, 'curso-a')
    await pedir(inter.url, { method: 'POST', path: '/v1/messages', headers: { authorization: `Bearer ${tokenCurso()}` }, body: cuerpoMensaje() })
    const anonima = await esperarRegistro(registro, l => l.estado === 401)
    assert.ok(anonima)
    assert.equal(anonima.reenviada, false)
    assert.equal(anonima.curso, null)
  })

  it('si el destino no responde, devuelve 502 sin filtrar el token', async () => {
    const d2 = dirTemporal()
    const cerrado = await puertoLibre()
    const i2 = await levantarIntermediario({
      dir: d2,
      tokenArchivo: real.ruta,
      cursosArchivo: archivoCursos(d2, [cursoA]),
      registro: path.join(d2, 'registro.jsonl'),
      destino: `http://127.0.0.1:${cerrado}`,
    })
    try {
      const r = await pedir(i2.url, { method: 'POST', path: '/v1/messages', headers: auth(), body: cuerpoMensaje() })
      assert.equal(r.estado, 502)
      assert.ok(!contieneSecreto(r.cuerpo, real.valor))
    } finally {
      await i2.detener()
    }
  })
})

describe('ataque: ante una configuración insegura el intermediario no arranca', () => {
  let dir, real, cursos

  before(async () => {
    compilarIntermediario()
    dir = dirTemporal()
    real = tokenRealFalso(dir)
    cursos = archivoCursos(dir, [{ curso: 'curso-a', token: tokenCurso() }])
  })

  async function noArranca(env, motivo) {
    const puerto = await puertoLibre()
    const salida = path.join(dir, `salida-${puerto}`)
    const { proceso, fin } = lanzarIntermediario({
      env: {
        INTERMEDIARIO_DIRECCION: `127.0.0.1:${puerto}`,
        INTERMEDIARIO_TOKEN_ARCHIVO: real.ruta,
        INTERMEDIARIO_CURSOS: cursos,
        INTERMEDIARIO_REGISTRO: path.join(dir, `registro-${puerto}.jsonl`),
        INTERMEDIARIO_DESTINO: 'http://127.0.0.1:9',
        ...env,
      },
      salida,
    })
    const r = await Promise.race([fin, esperar(5000).then(() => null)])
    if (!r) proceso.kill('SIGKILL')
    assert.ok(r, `${motivo}: el intermediario siguió corriendo`)
    assert.notEqual(r.code, 0, `${motivo}: terminó con código 0`)
  }

  it('sin archivo de token real', async () => {
    await noArranca({ INTERMEDIARIO_TOKEN_ARCHIVO: path.join(dir, 'no-existe') }, 'token inexistente')
  })

  it('con el archivo de token vacío', async () => {
    await noArranca({ INTERMEDIARIO_TOKEN_ARCHIVO: escribirSecreto(dir, 'vacio', '\n') }, 'token vacío')
  })

  it('con el archivo de token legible por otros usuarios', async () => {
    const abierto = escribirSecreto(dir, 'abierto', `${real.valor}\n`, 0o644)
    await noArranca({ INTERMEDIARIO_TOKEN_ARCHIVO: abierto }, 'token con permisos 644')
  })

  it('sin archivo de cursos', async () => {
    await noArranca({ INTERMEDIARIO_CURSOS: path.join(dir, 'no-existe-cursos') }, 'cursos inexistente')
  })

  it('con un token de curso que no empieza con curso- o es demasiado corto', async () => {
    await noArranca({ INTERMEDIARIO_CURSOS: escribirSecreto(dir, 'cursos-malo', 'curso-a sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx\n') }, 'token de curso con otro formato')
    await noArranca({ INTERMEDIARIO_CURSOS: escribirSecreto(dir, 'cursos-corto', 'curso-a curso-abc\n') }, 'token de curso corto')
  })

  it('con el token real como token de curso', async () => {
    await noArranca({ INTERMEDIARIO_CURSOS: escribirSecreto(dir, 'cursos-real', `curso-a ${real.valor}\n`) }, 'token real usado como token de curso')
  })

  it('con dos cursos que comparten token', async () => {
    const t = tokenCurso()
    await noArranca({ INTERMEDIARIO_CURSOS: escribirSecreto(dir, 'cursos-dup', `curso-a ${t}\ncurso-b ${t}\n`) }, 'token de curso duplicado')
  })

  it('sin archivo de registro configurado', async () => {
    await noArranca({ INTERMEDIARIO_REGISTRO: '' }, 'registro vacío')
  })
})
