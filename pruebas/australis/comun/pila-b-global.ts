import fs from 'node:fs';
import { ESTADO_B, estadoB, levantarPilaB } from './pila-b.ts';
import { DOMINIO } from './datos-b.ts';

export function reutilizar() {
  return process.env.AUSTRALIS_B_REUSAR === '1' && fs.existsSync(ESTADO_B);
}

export default async function preparar() {
  if (reutilizar()) return;
  const estado = await levantarPilaB();
  if (process.env.AUSTRALIS_B_MANTENER === '1') {
    const e = estadoB();
    console.log(`Pila lista. Núcleo: http://${DOMINIO}:${e.puerto}  Australis: http://campus.${DOMINIO}:${e.puerto}`);
    console.log(`Backend de Australis (solo pruebas): http://127.0.0.1:${e.puertoBackend}  Modelo falso (control): http://127.0.0.1:${e.puertoControl}/pedidos`);
    console.log(`Resolvé ${DOMINIO} y *.${DOMINIO} a 127.0.0.1 para abrirla en un navegador. Se baja con: pruebas/australis/checkpoint-b/pila.sh bajar`);
  }
  return estado;
}
