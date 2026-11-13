import fs from 'node:fs';
import path from 'node:path';
import { Cliente } from '../../comun/http.ts';
import { ADMIN_AUSTRAL, ALUMNO_REDES, DUENO_REDES, OWNER, REDES, crearTestDatos, expect } from '../fixtures.ts';
import { sesion, subirOk } from '../lib/datos.ts';

const test = crearTestDatos();
test.describe.configure({ mode: 'serial' });

function prepararRespaldos(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const crear = (nombre: string, bytes: number) => {
    fs.mkdirSync(path.join(dir, nombre), { recursive: true });
    fs.writeFileSync(path.join(dir, nombre, 'respaldo.tar.gz'), Buffer.alloc(bytes, 7));
    fs.writeFileSync(path.join(dir, nombre, 'respaldo.tar.gz.sha256'), 'x  respaldo.tar.gz\n');
  };
  crear('20261108-043000', 10);
  crear('20261109-043000', 2048);
  fs.mkdirSync(path.join(dir, '.armando-abc123'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.armando-abc123', 'respaldo.tar.gz'), 'a medias');
  fs.mkdirSync(path.join(dir, '20261110-999999'), { recursive: true });
  fs.writeFileSync(path.join(dir, '20261110-999999', 'respaldo.tar.gz'), 'nombre inválido');
  fs.mkdirSync(path.join(dir, '20261111-010000'), { recursive: true });
}

test.describe('página de estado del owner', () => {
  test('sin respaldos, el estado lo dice y muestra la salud del núcleo, los contenedores y el disco', async ({ nucleo }) => {
    const owner = await sesion(nucleo, OWNER);
    const r = await owner.get('/api/owner/estado');
    expect(r.status, r.texto).toBe(200);
    expect(r.json.nucleo.ok).toBe(true);
    expect(typeof r.json.nucleo.version).toBe('string');
    expect(Number.isNaN(Date.parse(r.json.nucleo.arranque))).toBe(false);
    expect(r.json.nucleo.segundos_activo).toBeGreaterThanOrEqual(0);
    expect(r.json.contenedores).toEqual({ proveedor: 'ninguno', encendidos: 0, cursos: 0 });
    expect(r.json.disco.total_bytes).toBeGreaterThan(0);
    expect(r.json.disco.libres_bytes).toBeGreaterThan(0);
    expect(r.json.disco.libres_bytes).toBeLessThanOrEqual(r.json.disco.total_bytes);
    expect(Number.isInteger(r.json.archivos.cantidad)).toBe(true);
    expect(Number.isInteger(r.json.archivos.bytes)).toBe(true);
    expect(r.json.respaldo).toEqual({ ultimo: null });
    expect(String(r.encabezados['cache-control'])).toBe('no-store');
  });

  test('informa el último respaldo válido y lo que ocupan los archivos', async ({ nucleo }) => {
    prepararRespaldos(nucleo.entorno.DIR_RESPALDOS);
    const owner = await sesion(nucleo, OWNER);
    const antes = (await owner.get('/api/owner/estado')).json.archivos;
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    await subirOk(alumno, REDES, 'estado.txt', Buffer.alloc(300, 1));
    const r = await owner.get('/api/owner/estado');
    expect(r.status).toBe(200);
    expect(r.json.respaldo.ultimo).toEqual({ nombre: '20261109-043000', fecha: '2026-11-09T04:30:00Z', bytes: 2048 });
    expect(r.json.archivos).toEqual({ cantidad: antes.cantidad + 1, bytes: antes.bytes + 300 });
  });

  test('nadie más que el owner lo ve', async ({ nucleo, cliente }) => {
    expect((await cliente().get('/api/owner/estado')).status).toBe(401);
    for (const email of [ADMIN_AUSTRAL, DUENO_REDES, ALUMNO_REDES]) {
      const c = await sesion(nucleo, email);
      const r = await c.get('/api/owner/estado');
      expect(r.status, email).toBe(403);
      expect(r.json.error).toBe('prohibido');
    }
  });

  test('la pestaña Estado del panel de owner muestra el estado', async ({ nucleo, paginaComo }) => {
    const owner = await sesion(nucleo, OWNER);
    const pagina = await paginaComo(owner);
    await pagina.goto(nucleo.url(undefined, '/owner'));
    const tab = pagina.locator('#tabs-owner [data-otab="estado"]');
    await expect(tab).toHaveText('Estado');
    await tab.click();
    await expect(tab).toHaveClass(/\bon\b/);
    await expect(pagina.locator('#estado-nucleo')).toContainText('Funcionando');
    await expect(pagina.locator('#estado-contenedores')).toContainText('0');
    await expect(pagina.locator('#estado-disco')).toContainText('GB libres');
    await expect(pagina.locator('#estado-respaldo')).toHaveAttribute('data-fecha', '2026-11-09T04:30:00Z');
    await expect(pagina.locator('#owner-cont .metricas .met')).toHaveCount(4);
  });
});
