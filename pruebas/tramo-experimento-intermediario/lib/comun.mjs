import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))

export const RAIZ = path.resolve(aqui, '..', '..', '..')
export const DIR_EXPERIMENTO = path.join(RAIZ, 'pruebas', 'experimento-intermediario')
export const DIR_INTERMEDIARIO = path.join(DIR_EXPERIMENTO, 'intermediario')
export const DIR_CONTENEDOR = path.join(DIR_EXPERIMENTO, 'contenedor')
export const BINARIO = process.env.EXPERIMENTO_BINARIO || path.join(DIR_INTERMEDIARIO, 'target', 'release', 'intermediario-experimento')
export const IMAGEN = 'campusia-experimento-claude:prueba'
export const ID_EXPERIMENTO = process.env.EXPERIMENTO_ID || `exp-${Date.now()}-${process.pid}`

export function dirTemporal(prefijo = 'campusia-exp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo))
  fs.chmodSync(dir, 0o700)
  return dir
}

export function aleatorio(n = 16) {
  return randomBytes(n).toString('hex')
}

export function tokenCurso() {
  return `curso-${aleatorio(16)}`
}

export function escribirSecreto(dir, nombre, contenido, modo = 0o600) {
  const ruta = path.join(dir, nombre)
  fs.writeFileSync(ruta, contenido, { mode: modo })
  fs.chmodSync(ruta, modo)
  return ruta
}

export function tokenRealFalso(dir) {
  const valor = `sk-ant-oat01-PRUEBA-${aleatorio(24)}`
  const ruta = escribirSecreto(dir, 'token-real-falso', `${valor}\n`)
  return { valor, ruta }
}

export function archivoCursos(dir, cursos) {
  const lineas = cursos.map(c => `${c.curso} ${c.token}`).join('\n') + '\n'
  return escribirSecreto(dir, 'cursos', lineas)
}

let compilado = false
export function compilarIntermediario() {
  if (compilado && fs.existsSync(BINARIO)) return
  if (process.env.EXPERIMENTO_BINARIO) { compilado = true; return }
  const manifiesto = path.join(DIR_INTERMEDIARIO, 'Cargo.toml')
  if (!fs.existsSync(manifiesto)) throw new Error(`No existe ${manifiesto}`)
  const r = spawnSync('bash', ['-c', `. "$HOME/.cargo/env" && cargo build --release --quiet --manifest-path "${manifiesto}"`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`Falló la compilación del intermediario:\n${(r.stderr || '').slice(-4000)}`)
  if (!fs.existsSync(BINARIO)) throw new Error(`La compilación no produjo ${BINARIO}`)
  compilado = true
}

export function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

export const esperar = ms => new Promise(r => setTimeout(r, ms))

export function lanzarIntermediario({ env, salida }) {
  const fd = fs.openSync(salida, 'a', 0o600)
  const proceso = spawn(BINARIO, [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', fd, fd],
  })
  fs.closeSync(fd)
  const fin = new Promise(resolve => {
    proceso.on('exit', (code, signal) => resolve({ code, signal }))
    proceso.on('error', err => resolve({ code: -1, signal: null, err }))
  })
  return { proceso, fin }
}

export async function levantarIntermediario({ tokenArchivo, cursosArchivo, registro, destino, direccion, dir, extra = {} }) {
  compilarIntermediario()
  const puerto = await puertoLibre()
  const host = direccion || '127.0.0.1'
  const salida = path.join(dir, `intermediario-${puerto}.salida`)
  const env = {
    INTERMEDIARIO_DIRECCION: `${host}:${puerto}`,
    INTERMEDIARIO_TOKEN_ARCHIVO: tokenArchivo,
    INTERMEDIARIO_CURSOS: cursosArchivo,
    INTERMEDIARIO_REGISTRO: registro,
    ...extra,
  }
  if (destino) env.INTERMEDIARIO_DESTINO = destino
  const { proceso, fin } = lanzarIntermediario({ env, salida })
  let terminado = null
  fin.then(r => { terminado = r })
  const url = `http://127.0.0.1:${puerto}`
  const limite = Date.now() + 15000
  while (Date.now() < limite) {
    if (terminado) throw new Error(`El intermediario terminó al arrancar (código ${terminado.code})`)
    try {
      const r = await pedir(url, { path: '/salud' })
      if (r.estado === 200) break
    } catch {}
    await esperar(100)
  }
  if (Date.now() >= limite) {
    proceso.kill('SIGKILL')
    throw new Error('El intermediario no respondió /salud en 15 s')
  }
  return {
    url,
    puerto,
    salida,
    registro,
    proceso,
    async detener() {
      if (terminado) return
      proceso.kill('SIGTERM')
      const t = setTimeout(() => proceso.kill('SIGKILL'), 3000)
      await fin
      clearTimeout(t)
    },
  }
}

export function pedir(base, { method = 'GET', path: ruta = '/', headers = {}, body, setHost } = {}) {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const inicio = Date.now()
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method,
      path: ruta,
      headers: { ...headers },
      setHost: setHost !== false,
    }, res => {
      const trozos = []
      const tiempos = []
      res.on('data', c => { trozos.push(c); tiempos.push({ ms: Date.now() - inicio, texto: c.toString('utf8') }) })
      res.on('end', () => {
        const cuerpo = Buffer.concat(trozos).toString('utf8')
        resolve({ estado: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, cuerpo, tiempos, total: Date.now() - inicio })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('tiempo agotado')))
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

export function leerRegistro(ruta) {
  if (!fs.existsSync(ruta)) return []
  return fs.readFileSync(ruta, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

export async function esperarRegistro(ruta, predicado, ms = 5000) {
  const limite = Date.now() + ms
  while (Date.now() < limite) {
    let lineas = []
    try { lineas = leerRegistro(ruta) } catch {}
    const hallada = lineas.find(predicado)
    if (hallada) return hallada
    await esperar(100)
  }
  return null
}

export function cuerpoMensaje(extra = {}) {
  return { model: 'claude-haiku-prueba', max_tokens: 16, messages: [{ role: 'user', content: 'hola' }], ...extra }
}

export function docker(args, opciones = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opciones })
}

export function construirImagen() {
  const dockerfile = path.join(DIR_CONTENEDOR, 'Dockerfile')
  if (!fs.existsSync(dockerfile)) throw new Error(`No existe ${dockerfile}`)
  const r = docker(['build', '-q', '-t', IMAGEN, DIR_CONTENEDOR], { timeout: 900000 })
  if (r.status !== 0) throw new Error(`Falló docker build:\n${(r.stderr || '').slice(-4000)}`)
}

export function correrClaude({ nombre, puerto, token, prompt, repo, extraArgs = [], extraEnv = {}, timeout = 240000 }) {
  const args = [
    'run', '--name', nombre,
    '--label', `campusia.experimento=${ID_EXPERIMENTO}`,
    '--add-host=host.docker.internal:host-gateway',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '-e', 'HOME=/tmp',
    '-e', `ANTHROPIC_BASE_URL=http://host.docker.internal:${puerto}`,
    '-e', `ANTHROPIC_AUTH_TOKEN=${token}`,
  ]
  for (const [k, v] of Object.entries(extraEnv)) args.push('-e', `${k}=${v}`)
  if (repo) args.push('-v', `${repo}:/repo`, '-w', '/repo')
  args.push(IMAGEN, 'claude', '-p', prompt, '--model', 'haiku', ...extraArgs)
  const r = docker(args, { timeout })
  return { codigo: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error }
}

export function contieneSecreto(texto, secreto) {
  if (!secreto || secreto.length < 20) throw new Error('Secreto vacío o demasiado corto para buscarlo')
  return String(texto).includes(secreto)
}

export function streamContiene(stream, secreto) {
  if (!secreto || secreto.length < 20) return Promise.reject(new Error('Secreto vacío o demasiado corto para buscarlo'))
  const aguja = Buffer.from(secreto)
  return new Promise((resolve, reject) => {
    let cola = Buffer.alloc(0)
    let hallado = false
    stream.on('data', c => {
      if (hallado) return
      const b = Buffer.concat([cola, c])
      if (b.indexOf(aguja) !== -1) hallado = true
      cola = b.subarray(Math.max(0, b.length - aguja.length + 1))
    })
    stream.on('end', () => resolve(hallado))
    stream.on('error', reject)
  })
}

export function archivosVersionados() {
  const r = spawnSync('git', ['-C', RAIZ, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ls-files falló: ${r.stderr}`)
  return r.stdout.split('\0').filter(Boolean).map(f => path.join(RAIZ, f)).filter(f => {
    try { return fs.statSync(f).isFile() } catch { return false }
  })
}
