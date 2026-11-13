import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  ID_EXPERIMENTO, IMAGEN, archivoCursos, construirImagen, correrClaude, dirTemporal, docker, esperarRegistro, leerRegistro,
  levantarIntermediario, tokenCurso,
} from '../lib/comun.mjs'
import { rutaTokenReal } from '../lib/token-real.mjs'

const SALIDA = process.env.EXPERIMENTO_SALIDA || dirTemporal('campusia-exp-salida-')
const CURSO = 'experimento'

function guardar(nombre, contenido) {
  fs.writeFileSync(path.join(SALIDA, nombre), contenido, { mode: 0o600 })
}

describe('aceptación: Claude Code en un contenedor usa la suscripción a través del intermediario', () => {
  let dir, inter, registro, token, repo
  const contenedores = []

  before(async () => {
    dir = dirTemporal()
    token = tokenCurso()
    registro = path.join(dir, 'registro.jsonl')
    construirImagen()
    inter = await levantarIntermediario({
      dir,
      direccion: '0.0.0.0',
      tokenArchivo: rutaTokenReal(),
      cursosArchivo: archivoCursos(dir, [{ curso: CURSO, token }]),
      registro,
    })
    repo = dirTemporal('campusia-exp-repo-')
    fs.chmodSync(repo, 0o755)
    fs.writeFileSync(path.join(repo, 'saludo.txt'), 'hola\n')
    spawnSync('git', ['init', '-q'], { cwd: repo })
    spawnSync('git', ['-c', 'user.email=prueba@localhost', '-c', 'user.name=prueba', 'add', '.'], { cwd: repo })
    spawnSync('git', ['-c', 'user.email=prueba@localhost', '-c', 'user.name=prueba', 'commit', '-q', '-m', 'inicial'], { cwd: repo })
  })

  after(async () => {
    if (inter) await inter.detener()
    guardar('contenedores.json', JSON.stringify(contenedores))
    if (fs.existsSync(registro)) guardar('registro-real.jsonl', fs.readFileSync(registro))
    if (inter && fs.existsSync(inter.salida)) guardar('intermediario-real.salida', fs.readFileSync(inter.salida))
  })

  it('la imagen trae Node 22 y Claude Code', () => {
    const n = docker(['run', '--rm', '--label', `campusia.experimento=${ID_EXPERIMENTO}`, IMAGEN, 'node', '--version'])
    assert.equal(n.status, 0, n.stderr)
    assert.match(n.stdout.trim(), /^v22\./)
    const c = docker(['run', '--rm', '--label', `campusia.experimento=${ID_EXPERIMENTO}`, IMAGEN, 'claude', '--version'])
    assert.equal(c.status, 0, c.stderr)
    assert.match(c.stdout, /\d+\.\d+\.\d+/)
  })

  it('claude -p responde "ok" con el token falso del curso', { timeout: 300000 }, async () => {
    const nombre = `${ID_EXPERIMENTO}-ok`
    contenedores.push(nombre)
    const r = correrClaude({ nombre, puerto: inter.puerto, token, prompt: 'Respondé solo: ok' })
    guardar(`${nombre}.stdout`, r.stdout)
    guardar(`${nombre}.stderr`, r.stderr)
    assert.equal(r.codigo, 0, `claude terminó con ${r.codigo}\nstdout: ${r.stdout.slice(-2000)}\nstderr: ${r.stderr.slice(-2000)}`)
    assert.match(r.stdout, /\bok\b/i)
    const linea = await esperarRegistro(registro, l => l.curso === CURSO && l.ruta === '/v1/messages' && l.estado === 200 && l.reenviada === true && l.tokens_salida > 0)
    assert.ok(linea, `el registro no tiene una consulta exitosa: ${JSON.stringify(leerRegistro(registro))}`)
  })

  it('claude -p edita un archivo del repo montado', { timeout: 300000 }, async () => {
    const nombre = `${ID_EXPERIMENTO}-edicion`
    contenedores.push(nombre)
    const r = correrClaude({
      nombre,
      puerto: inter.puerto,
      token,
      repo,
      prompt: 'En el archivo saludo.txt reemplazá la palabra hola por chau. No hagas nada más.',
      extraArgs: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write'],
    })
    guardar(`${nombre}.stdout`, r.stdout)
    guardar(`${nombre}.stderr`, r.stderr)
    assert.equal(r.codigo, 0, `claude terminó con ${r.codigo}\nstdout: ${r.stdout.slice(-2000)}\nstderr: ${r.stderr.slice(-2000)}`)
    const contenido = fs.readFileSync(path.join(repo, 'saludo.txt'), 'utf8')
    assert.match(contenido, /chau/i)
    assert.doesNotMatch(contenido, /hola/i)
  })

  it('el consumo de las dos corridas es acotado y con el modelo más chico', () => {
    const lineas = leerRegistro(registro).filter(l => l.curso === CURSO && l.reenviada === true)
    const mensajes = lineas.filter(l => l.ruta === '/v1/messages')
    const resumen = {
      consultas: mensajes.length,
      modelos: [...new Set(mensajes.map(l => l.modelo))],
      tokens_entrada: mensajes.reduce((s, l) => s + (l.tokens_entrada || 0), 0),
      tokens_salida: mensajes.reduce((s, l) => s + (l.tokens_salida || 0), 0),
      tokens_cache_creacion: mensajes.reduce((s, l) => s + (l.tokens_cache_creacion || 0), 0),
      tokens_cache_lectura: mensajes.reduce((s, l) => s + (l.tokens_cache_lectura || 0), 0),
      rutas: [...new Set(leerRegistro(registro).map(l => `${l.metodo} ${l.ruta} ${l.estado}`))],
    }
    guardar('uso.json', JSON.stringify(resumen, null, 2))
    console.log(`uso registrado: ${JSON.stringify(resumen)}`)
    assert.ok(mensajes.length >= 2, 'hubo menos de dos consultas registradas')
    assert.ok(mensajes.length <= 20, `se hicieron ${mensajes.length} consultas`)
    for (const l of mensajes) assert.match(String(l.modelo), /haiku/i, `consulta con modelo ${l.modelo}`)
    assert.ok(resumen.tokens_salida <= 5000, `se generaron ${resumen.tokens_salida} tokens de salida`)
  })
})
