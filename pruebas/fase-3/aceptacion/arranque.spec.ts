import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crearTest, expect } from '../../comun/fixtures.ts';
import { BINARIO } from '../../comun/entorno.ts';
import { Cliente } from '../../comun/http.ts';
import { entrar } from '../../comun/sesion.ts';
import { SEMILLA, OWNER, PROFE_AUSTRAL, ALUMNO_AUSTRAL, ADMIN_AUSTRAL } from '../../fase-2/fixtures.ts';

const test = crearTest({ semilla: SEMILLA, owner: OWNER });

function arrancar(entorno: Record<string, string>, quitar: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env, ...entorno, PUERTO: '0' };
  for (const k of quitar) delete env[k];
  const r = spawnSync(BINARIO, [], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 8000 });
  return { status: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const tokenFalso = () => `sk-ant-oat01-PRUEBA-${crypto.randomBytes(24).toString('base64url')}`;

test.describe('arranque con el proveedor del modelo', () => {
  test('un proveedor desconocido no arranca', async ({ nucleo }) => {
    const r = arrancar({ ...nucleo.entorno, PROVEEDOR_MODELO: 'otro' });
    expect(r.status).not.toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.salida).toContain('PROVEEDOR_MODELO');
  });

  test('suscripción sin token no arranca', async ({ nucleo }) => {
    const r = arrancar({ ...nucleo.entorno, PROVEEDOR_MODELO: 'suscripcion' }, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(r.status).not.toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.salida).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    const vacio = arrancar({ ...nucleo.entorno, PROVEEDOR_MODELO: 'suscripcion', CLAUDE_CODE_OAUTH_TOKEN: '' }, ['ANTHROPIC_API_KEY']);
    expect(vacio.status).not.toBeNull();
    expect(vacio.status).not.toBe(0);
  });

  test('api sin clave no arranca', async ({ nucleo }) => {
    const r = arrancar({ ...nucleo.entorno, PROVEEDOR_MODELO: 'api' }, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(r.status).not.toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.salida).toContain('ANTHROPIC_API_KEY');
  });

  test('una tabla de precios ausente o inválida no arranca y el error no muestra el token', async ({ nucleo }) => {
    const token = tokenFalso();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-precios-'));
    const malo = path.join(dir, 'precios.json');
    fs.writeFileSync(malo, '{"claude": ');
    try {
      for (const archivo of [malo, path.join(dir, 'no-existe.json')]) {
        const r = arrancar({ ...nucleo.entorno, PROVEEDOR_MODELO: 'suscripcion', CLAUDE_CODE_OAUTH_TOKEN: token, PRECIOS_MODELO_ARCHIVO: archivo });
        expect(r.status, archivo).not.toBeNull();
        expect(r.status, archivo).not.toBe(0);
        expect(r.salida).toContain('PRECIOS_MODELO_ARCHIVO');
        expect(r.salida).not.toContain(token);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sin proveedor el agente responde 503 y las lecturas funcionan', async ({ nucleo }) => {
    const profe = new Cliente(nucleo);
    await entrar(profe, PROFE_AUSTRAL);
    const a = await profe.post('/api/cursos/redes/agente', { pedido: 'Hola' });
    expect(a.status).toBe(503);
    expect(a.json.error).toBe('servicio_no_disponible');
    const vacio = await profe.post('/api/cursos/redes/agente', { pedido: '   ' });
    expect(vacio.status).toBe(400);
    expect(vacio.json.error).toBe('datos_invalidos');
    const largo = await profe.post('/api/cursos/redes/agente', { pedido: 'x'.repeat(8001) });
    expect(largo.status).toBe(400);
    const e = await profe.post('/api/cursos/redes/espacio', {});
    expect(e.status).toBe(503);
    const p = await profe.post('/api/cursos/redes/publicar', {});
    expect(p.status).toBe(503);
    const g = await profe.get('/api/cursos/redes/agente');
    expect(g.status).toBe(200);
    expect(g.json).toEqual({ mensajes: [], en_curso: false });
    const v = await profe.get('/api/cursos/redes/versiones');
    expect(v.status).toBe(200);
    expect(v.json).toEqual({ publicada: 12, cambios_sin_publicar: false, versiones: [] });
    const es = await profe.get('/api/cursos/redes/espacio');
    expect(es.status).toBe(200);
    expect(es.json).toEqual({ espacio: 'ninguno', error: null });
    const c = await profe.get('/api/cursos/redes');
    expect(c.json.espacio).toBe('ninguno');
    expect(c.json.cambios_sin_publicar).toBe(false);
    const u = await profe.get('/api/cursos/redes/uso');
    expect(u.status).toBe(200);
    expect(u.json.usd).toBe(31);

    const alumno = new Cliente(nucleo);
    await entrar(alumno, ALUMNO_AUSTRAL);
    expect((await alumno.post('/api/cursos/redes/agente', { pedido: 'Hola' })).status).toBe(403);
    const admin = new Cliente(nucleo);
    await entrar(admin, ADMIN_AUSTRAL);
    expect((await admin.post('/api/cursos/redes/agente', { pedido: 'Hola' })).status).toBe(404);

    const prueba = await profe.get('/', { sub: 'redes-prueba' });
    expect(prueba.status).toBe(404);
  });
});
