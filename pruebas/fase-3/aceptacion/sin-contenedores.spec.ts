import crypto from 'node:crypto';
import { crearTest, expect } from '../../comun/fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { entrar } from '../../comun/sesion.ts';
import { SEMILLA, OWNER, PROFE_AUSTRAL, ALUMNO_AUSTRAL, ADMIN_AUSTRAL } from '../../fase-2/fixtures.ts';

const test = crearTest({
  semilla: SEMILLA,
  owner: OWNER,
  entorno: {
    PROVEEDOR_CONTENEDORES: 'ninguno',
    PROVEEDOR_MODELO: 'suscripcion',
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-PRUEBA-${crypto.randomBytes(24).toString('base64url')}`,
    MODELO_DESTINO: 'http://127.0.0.1:9',
  },
});

test.describe('sin proveedor de contenedores', () => {
  test('encender, pedir al agente, publicar y volver responden 503 y las lecturas funcionan', async ({ nucleo }) => {
    expect(nucleo.entorno.PROVEEDOR_CONTENEDORES).toBe('ninguno');
    const profe = new Cliente(nucleo);
    await entrar(profe, PROFE_AUSTRAL);
    const curso = await profe.get('/api/cursos/redes');
    expect(curso.status).toBe(200);
    expect(curso.json.espacio).toBe('ninguno');
    expect(curso.json.cambios_sin_publicar).toBe(false);
    const modificaciones: Array<[string, any]> = [
      ['/api/cursos/redes/espacio', {}],
      ['/api/cursos/redes/agente', { pedido: 'Hola' }],
      ['/api/cursos/redes/publicar', {}],
      ['/api/cursos/redes/publicar', { descripcion: 'Nueva' }],
      ['/api/cursos/redes/versiones/12/volver', {}],
      ['/api/cursos/redes/versiones/1/volver', {}],
    ];
    for (const [ruta, cuerpo] of modificaciones) {
      const r = await profe.post(ruta, cuerpo);
      expect(r.status, `${ruta}: ${r.texto}`).toBe(503);
      expect(r.json.error, ruta).toBe('servicio_no_disponible');
    }
    const vacio = await profe.post('/api/cursos/redes/agente', { pedido: '   ' });
    expect(vacio.status).toBe(400);
    const largo = await profe.post('/api/cursos/redes/publicar', { descripcion: 'x'.repeat(201) });
    expect(largo.status).toBe(400);
    const lecturas: Array<[string, any]> = [
      ['/api/cursos/redes/espacio', { espacio: 'ninguno', error: null }],
      ['/api/cursos/redes/agente', { mensajes: [], en_curso: false }],
      ['/api/cursos/redes/versiones', { publicada: 12, cambios_sin_publicar: false, versiones: [] }],
      ['/api/cursos/redes/publicaciones', { publicaciones: [] }],
    ];
    for (const [ruta, esperado] of lecturas) {
      const r = await profe.get(ruta);
      expect(r.status, ruta).toBe(200);
      expect(r.json, ruta).toEqual(esperado);
    }
    const u = await profe.get('/api/cursos/redes/uso');
    expect(u.status).toBe(200);
    expect(u.json.usd).toBe(31);

    const alumno = new Cliente(nucleo);
    await entrar(alumno, ALUMNO_AUSTRAL);
    for (const [ruta, cuerpo] of modificaciones) expect((await alumno.post(ruta, cuerpo)).status, ruta).toBe(403);
    const admin = new Cliente(nucleo);
    await entrar(admin, ADMIN_AUSTRAL);
    for (const [ruta, cuerpo] of modificaciones) expect((await admin.post(ruta, cuerpo)).status, ruta).toBe(404);
    const modelo = await profe.post('/modelo/v1/messages', { model: 'x', max_tokens: 1, messages: [] });
    expect(modelo.status).toBe(404);
  });
});
