import http from 'node:http';

function servir(nombre, puerto) {
  http.createServer((req, res) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      const registro = {
        servicio: nombre,
        metodo: req.method,
        ruta: req.url,
        host: req.headers.host || '',
        id: req.headers['x-prueba-id'] || '',
        cf: req.headers['cf-connecting-ip'] || '',
        xff: req.headers['x-forwarded-for'] || '',
        par: req.socket.remoteAddress,
        bytes: Buffer.concat(partes).length,
      };
      process.stdout.write(JSON.stringify(registro) + '\n');
      const cuerpo = JSON.stringify(registro);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(cuerpo) });
      res.end(cuerpo);
    });
  }).listen(puerto, '127.0.0.1');
}

servir('nucleo', 8080);
servir('receptor', 9010);
