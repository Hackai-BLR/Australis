import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { levantarNucleoCursos, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../../fase-2/fixtures.ts';
import { limpiarPrefijo } from '../../fase-2/lib/docker.ts';
import { ejecutarSql, inscribirOk, sesion } from '../../fase-2/lib/cursos.ts';
import { puertoLibre } from '../../comun/servicios-falsos.ts';
import { asegurarImagenEspacio } from '../lib/imagen.ts';
import { ESPERA_RECARGA_MS, cursoConEspacio, enPrueba, enPublicado, esperarRespuesta, filasUso, pedidoOk, publicarOk } from '../lib/agente.ts';

const ARCHIVO_TOKEN = process.env.CAMPUSIA_TOKEN_ARCHIVO ?? path.join(os.homedir(), '.config', 'campusia', 'claude-oauth-token');

test.describe('con el modelo real', () => {
  test.skip(process.env.CAMPUSIA_MODELO_REAL !== '1', 'Solo con CAMPUSIA_MODELO_REAL=1 (pruebas/fase-3/manual/modelo-real.sh)');
  test.setTimeout(3_600_000);

  test('el profesor pide un cambio real, lo ve en prueba, lo publica y lo ve publicado', async () => {
    const token = fs.readFileSync(ARCHIVO_TOKEN, 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    const imagen = await asegurarImagenEspacio();
    const raizEspacios = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-espacios-real-'));
    const n = await levantarNucleoCursos({
      entorno: {
        PROVEEDOR_MODELO: 'suscripcion',
        CLAUDE_CODE_OAUTH_TOKEN: token,
        MODELO_AGENTE: 'haiku',
        ESPACIO_IMAGEN: imagen,
        RAIZ_ESPACIOS: raizEspacios,
        PUERTO_ESPACIOS: String(await puertoLibre()),
        PUERTO_PROXY_SALIDA: String(await puertoLibre()),
      },
    });
    const inicio = Date.now();
    try {
      ejecutarSql(n, "UPDATE universidades SET limite_usd = 1000 WHERE nombre = 'Universidad Austral'");
      const profe = await sesion(n, PROFE_AUSTRAL);
      const alumno = await sesion(n, ALUMNO_AUSTRAL);
      const id = await cursoConEspacio(profe, { nombre: 'Curso con el Modelo Real' });
      await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
      const { respuesta } = await pedidoOk(
        profe,
        id,
        "En servidor/app.ts agregá, justo después de la línea de la ruta '/salud', una ruta GET '/hola' que responda c.json({ hola: 'mundo' }). No cambies nada más.",
      );
      expect(respuesta.archivos.map((a: any) => a.ruta)).toContain('servidor/app.ts');
      await esperarRespuesta(() => enPrueba(profe, id, '/hola'), (r) => r.status === 200 && r.json?.hola === 'mundo', ESPERA_RECARGA_MS, 'la prueba responde /hola');
      const p = await publicarOk(profe, id);
      expect(p.version).toBe(1);
      const pub = await enPublicado(alumno, id, '/hola');
      expect(pub.json).toEqual({ hola: 'mundo' });
      const filas = filasUso(n as any, id);
      expect(filas.length).toBeGreaterThan(0);
      const salida = filas.reduce((s, f) => s + Number(f.tokens_salida), 0);
      const usd = filas.reduce((s, f) => s + Number(f.usd), 0);
      expect(salida).toBeGreaterThan(0);
      expect(usd).toBeGreaterThan(0);
      const registro = fs.readFileSync(n.archivoRegistro, 'utf8');
      expect(registro.includes(token)).toBe(false);
      console.log(
        `Modelo real: ${filas.length} consultas, modelos ${[...new Set(filas.map((f) => f.modelo))].join(', ')}, ${salida} tokens de salida, USD ${usd.toFixed(4)}, ${Math.round((Date.now() - inicio) / 1000)} s`,
      );
    } finally {
      await n.cerrar();
      limpiarPrefijo(n.prefijo);
      fs.rmSync(n.raizCursos, { recursive: true, force: true });
      fs.rmSync(raizEspacios, { recursive: true, force: true });
    }
  });
});
