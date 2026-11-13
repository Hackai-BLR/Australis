import http from 'node:http'

function sse(res, eventos) {
  for (const [evento, datos] of eventos) res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`)
}

const inicioMensaje = (modelo, uso) => ['message_start', {
  type: 'message_start',
  message: { id: 'msg_prueba', type: 'message', role: 'assistant', model: modelo, content: [], stop_reason: null, usage: uso },
}]

const restoMensaje = salida => [
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: salida } }],
  ['message_stop', { type: 'message_stop' }],
]

export function crearUpstreamFalso() {
  const recibidas = []
  const servidor = http.createServer((req, res) => {
    const trozos = []
    req.on('data', c => trozos.push(c))
    req.on('end', () => {
      const cuerpo = Buffer.concat(trozos).toString('utf8')
      const u = new URL(req.url, 'http://upstream')
      recibidas.push({ metodo: req.method, url: req.url, ruta: u.pathname, query: u.search, headers: req.headers, rawHeaders: req.rawHeaders, cuerpo })
      let json = null
      try { json = JSON.parse(cuerpo) } catch {}
      const auth = req.headers.authorization || ''
      const modelo = (json && json.model) || 'claude-haiku-prueba'

      if (u.pathname === '/v1/messages' && u.searchParams.get('estado')) {
        const estado = Number(u.searchParams.get('estado'))
        res.writeHead(estado, { 'content-type': 'application/json', 'retry-after': '7', 'x-prueba': 'estado' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limite de prueba' } }))
        return
      }
      if (u.pathname === '/v1/messages' && json && json.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        sse(res, [inicioMensaje(modelo, { input_tokens: 25, output_tokens: 1, cache_creation_input_tokens: 4, cache_read_input_tokens: 3 })])
        const demora = u.searchParams.get('lento') ? 1500 : 0
        setTimeout(() => {
          sse(res, restoMensaje(9))
          res.end()
        }, demora)
        return
      }
      if (u.pathname === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_prueba' })
        res.end(JSON.stringify({
          id: 'msg_prueba', type: 'message', role: 'assistant', model: modelo,
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 5 },
        }))
        return
      }
      if (u.pathname === '/v1/eco') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-eco-auth': auth })
        res.end(JSON.stringify({ headers: req.headers, error: { message: `credencial recibida: ${auth}` } }))
        return
      }
      if (u.pathname === '/v1/eco-stream') {
        const valor = auth.replace(/^Bearer\s+/i, '')
        const mitad = Math.floor(valor.length / 2)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: ping\ndata: {"a":"${valor.slice(0, mitad)}`)
        setTimeout(() => {
          res.write(`${valor.slice(mitad)}"}\n\n`)
          res.end()
        }, 150)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ruta: u.pathname, data: [] }))
    })
  })
  return new Promise(resolve => {
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        puerto: port,
        recibidas,
        cerrar: () => new Promise(r => { servidor.closeAllConnections(); servidor.close(() => r()) }),
      })
    })
  })
}
