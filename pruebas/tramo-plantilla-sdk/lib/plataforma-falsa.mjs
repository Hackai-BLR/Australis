import http from 'node:http';

export const TOKEN = 'token-prueba-redes';

export const CURSO = { id: 'redes', nombre: 'Redes de Computadoras', periodo: '2.º cuatrimestre 2026' };

export const INSCRIPTOS = [
  { id: 'u-duenio', nombre: 'Lucía Fernández', email: 'lucia.fernandez@austral.edu.ar', rol: 'dueño' },
  { id: 'u-profe-2', nombre: 'Martín Sosa', email: 'martin.sosa@austral.edu.ar', rol: 'profesor' },
  { id: 'u-alumno-1', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar', rol: 'alumno' },
  { id: 'u-alumno-2', nombre: 'Bruno Díaz', email: 'bruno.diaz@austral.edu.ar', rol: 'alumno' },
];

export async function levantarPlataforma({ host = '0.0.0.0', prefijo = '', manejador } = {}) {
  const pedidos = [];
  const servidor = http.createServer((req, res) => {
    pedidos.push({ metodo: req.method, url: req.url, encabezados: { ...req.headers } });
    if (manejador && manejador(req, res) !== false) return;
    const enviar = (estado, cuerpo) => {
      res.writeHead(estado, { 'content-type': 'application/json' });
      res.end(JSON.stringify(cuerpo));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return enviar(401, { error: 'no_autorizado' });
    if (req.method === 'GET' && req.url === `${prefijo}/api/curso/yo`) return enviar(200, CURSO);
    if (req.method === 'GET' && req.url === `${prefijo}/api/curso/inscriptos`) return enviar(200, INSCRIPTOS);
    return enviar(404, { error: 'no_encontrado' });
  });
  await new Promise((r) => servidor.listen(0, host, r));
  const puerto = servidor.address().port;
  return {
    puerto,
    pedidos,
    url: `http://127.0.0.1:${puerto}${prefijo}`,
    cerrar: () => new Promise((r) => { servidor.closeAllConnections?.(); servidor.close(() => r()); }),
  };
}
