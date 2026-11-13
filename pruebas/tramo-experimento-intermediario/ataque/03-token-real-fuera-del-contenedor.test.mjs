import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  ID_EXPERIMENTO, IMAGEN, archivoCursos, archivosVersionados, construirImagen, contieneSecreto, correrClaude, dirTemporal, docker,
  esperar, leerRegistro, levantarIntermediario, streamContiene, tokenCurso,
} from '../lib/comun.mjs'
import { rutaTokenReal, valorTokenReal } from '../lib/token-real.mjs'

const SALIDA = process.env.EXPERIMENTO_SALIDA

function dockerStream(args) {
  const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const fin = new Promise(r => p.on('exit', code => r(code)))
  return { stdout: p.stdout, fin }
}

describe('ataque: el token real no llega al contenedor ni al repo', () => {
  let secreto, contenedores

  before(() => {
    secreto = valorTokenReal()
    construirImagen()
    const lista = SALIDA && path.join(SALIDA, 'contenedores.json')
    contenedores = lista && fs.existsSync(lista) ? JSON.parse(fs.readFileSync(lista, 'utf8')) : []
  })

  it('las corridas reales de aceptación dejaron sus contenedores para revisar', () => {
    assert.ok(SALIDA, 'falta EXPERIMENTO_SALIDA: correr con pruebas/tramo-experimento-intermediario/correr.sh')
    assert.ok(contenedores.length >= 2, 'no hay contenedores de las corridas reales para revisar')
  })

  it('la configuración de la imagen y de los contenedores no tiene el token ni credenciales de Anthropic', () => {
    for (const objetivo of [IMAGEN, ...contenedores]) {
      const r = docker(['inspect', objetivo])
      assert.equal(r.status, 0, `no se pudo inspeccionar ${objetivo}`)
      assert.ok(!contieneSecreto(r.stdout, secreto), `el token real aparece en la configuración de ${objetivo}`)
      assert.doesNotMatch(r.stdout, /sk-ant-/, `hay una credencial de Anthropic en la configuración de ${objetivo}`)
      assert.doesNotMatch(r.stdout, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY=sk/, `hay una variable de credencial real en ${objetivo}`)
    }
  })

  it('las capas de la imagen no contienen el token', { timeout: 600000 }, async () => {
    const { stdout, fin } = dockerStream(['save', IMAGEN])
    const hallado = await streamContiene(stdout, secreto)
    assert.equal(await fin, 0, 'docker save falló')
    assert.ok(!hallado, 'el token real está dentro de la imagen')
  })

  it('el sistema de archivos de los contenedores después de correr no contiene el token', { timeout: 600000 }, async () => {
    for (const c of contenedores) {
      const { stdout, fin } = dockerStream(['export', c])
      const hallado = await streamContiene(stdout, secreto)
      assert.equal(await fin, 0, `docker export ${c} falló`)
      assert.ok(!hallado, `el token real quedó en el sistema de archivos de ${c}`)
    }
  })

  it('la salida de Claude Code en el contenedor no contiene el token', () => {
    for (const c of contenedores) {
      for (const ext of ['stdout', 'stderr']) {
        const f = path.join(SALIDA, `${c}.${ext}`)
        assert.ok(fs.existsSync(f), `falta ${c}.${ext}`)
        assert.ok(!contieneSecreto(fs.readFileSync(f, 'utf8'), secreto), `el token real apareció en ${ext} de ${c}`)
      }
      const logs = docker(['logs', c])
      assert.ok(!contieneSecreto(`${logs.stdout}${logs.stderr}`, secreto), `el token real apareció en docker logs de ${c}`)
    }
  })

  it('el registro y la salida del intermediario real no contienen el token', () => {
    for (const nombre of ['registro-real.jsonl', 'intermediario-real.salida']) {
      const f = path.join(SALIDA, nombre)
      assert.ok(fs.existsSync(f), `falta ${nombre}`)
      assert.ok(!contieneSecreto(fs.readFileSync(f, 'utf8'), secreto), `el token real apareció en ${nombre}`)
    }
  })

  it('ningún archivo versionable del repo contiene el token', () => {
    for (const f of archivosVersionados()) {
      if (fs.statSync(f).size > 64 * 1024 * 1024) continue
      assert.ok(!fs.readFileSync(f).includes(secreto), `el token real está en ${path.relative(process.cwd(), f)}`)
    }
  })
})

describe('ataque: el contenedor no consigue usar la suscripción sin un token de curso válido', () => {
  let dir, inter, registro, secreto
  const nombre = `${ID_EXPERIMENTO}-invalido`

  before(async () => {
    secreto = valorTokenReal()
    construirImagen()
    dir = dirTemporal()
    registro = path.join(dir, 'registro.jsonl')
    inter = await levantarIntermediario({
      dir,
      direccion: '0.0.0.0',
      tokenArchivo: rutaTokenReal(),
      cursosArchivo: archivoCursos(dir, [{ curso: 'experimento', token: tokenCurso() }]),
      registro,
    })
  })

  after(async () => {
    if (inter) await inter.detener()
    docker(['rm', '-f', nombre])
  })

  it('claude -p con un token de curso inventado falla y nada se reenvía', { timeout: 300000 }, async () => {
    const r = correrClaude({ nombre, puerto: inter.puerto, token: tokenCurso(), prompt: 'Respondé solo: ok', timeout: 180000 })
    await esperar(500)
    assert.ok(r.codigo !== 0 || !/\bok\b/i.test(r.stdout), `claude respondió con un token inventado: ${r.stdout.slice(-500)}`)
    assert.ok(!contieneSecreto(`${r.stdout}${r.stderr}`, secreto))
    const reenviadas = leerRegistro(registro).filter(l => l.reenviada === true)
    assert.equal(reenviadas.length, 0, `se reenviaron ${reenviadas.length} peticiones con un token inventado`)
    assert.ok(leerRegistro(registro).some(l => l.estado === 401), 'el intermediario no registró el rechazo')
  })
})
