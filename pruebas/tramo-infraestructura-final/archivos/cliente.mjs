import https from 'node:https';

const [destino, lista] = process.argv.slice(2);
const pedidos = JSON.parse(lista);

function pedir(p) {
  return new Promise((resolver) => {
    const cuerpo = p.cuerpo ? Buffer.from(p.cuerpo) : null;
    const encabezados = { host: p.host || 'campusia.tech', 'x-prueba-id': p.id, ...(p.encabezados || {}) };
    if (cuerpo) encabezados['content-length'] = String(cuerpo.length);
    const req = https.request({
      host: destino,
      port: 443,
      method: p.metodo,
      path: p.ruta,
      servername: p.sni || 'campusia.tech',
      headers: encabezados,
      rejectUnauthorized: false,
      timeout: 8000,
    }, (res) => {
      const partes = [];
      res.on('data', (x) => partes.push(x));
      res.on('end', () => resolver({ id: p.id, estado: res.statusCode, cuerpo: Buffer.concat(partes).toString() }));
      res.on('error', (e) => resolver({ id: p.id, error: String(e.code || e.message) }));
    });
    req.on('timeout', () => req.destroy(new Error('tiempo')));
    req.on('error', (e) => resolver({ id: p.id, error: String(e.code || e.message) }));
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

const resultados = [];
for (const p of pedidos) resultados.push(await pedir(p));
process.stdout.write(JSON.stringify(resultados));
