import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ALUMNO_REDES, DUENO_REDES, PROFE_REDES, MIEMBROS_REDES, crearTestDatos, expect } from '../fixtures.ts';
import { bajar, entregarOk, idUsuario, ponerNotaOk, rutaArchivo, sesion, subirOk, verEntregas, verHistorial, cursoAislado } from '../lib/datos.ts';

const test = crearTestDatos();
const C = { id: '' };
test.beforeAll(({ nucleo }) => {
  C.id = cursoAislado(nucleo, 'inm', MIEMBROS_REDES);
});
test.describe.configure({ mode: 'serial' });

let archivo = '';
let entrega = 0;
let nota = 0;

test.describe('los registros solo se agregan', () => {
  test.beforeAll(async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const profe = await sesion(nucleo, PROFE_REDES);
    archivo = (await subirOk(alumno, C.id, 'original.txt', 'contenido original')).id;
    entrega = (await entregarOk(alumno, C.id, { actividad: 'tp1', texto: 'texto original', archivo_id: archivo })).id;
    nota = (await ponerNotaOk(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '6' })).id;
  });

  test('la API no tiene forma de editar ni borrar entregas, notas ni archivos', async ({ nucleo }) => {
    const dueno = await sesion(nucleo, DUENO_REDES);
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    for (const c of [dueno, alumno]) {
      for (const [metodo, ruta] of [
        ['PUT', `/api/cursos/${C.id}/entregas/${entrega}`],
        ['PATCH', `/api/cursos/${C.id}/entregas/${entrega}`],
        ['DELETE', `/api/cursos/${C.id}/entregas/${entrega}`],
        ['DELETE', `/api/cursos/${C.id}/entregas`],
        ['PUT', `/api/cursos/${C.id}/entregas`],
        ['PUT', `/api/cursos/${C.id}/notas/${nota}`],
        ['PATCH', `/api/cursos/${C.id}/notas/${nota}`],
        ['DELETE', `/api/cursos/${C.id}/notas/${nota}`],
        ['DELETE', `/api/cursos/${C.id}/notas`],
        ['DELETE', `/api/cursos/${C.id}/notas/historial`],
        ['PUT', `/api/cursos/${C.id}/archivos/${archivo}`],
        ['PATCH', `/api/cursos/${C.id}/archivos/${archivo}`],
        ['DELETE', `/api/cursos/${C.id}/archivos/${archivo}`],
        ['POST', `/api/cursos/${C.id}/archivos/${archivo}`],
      ] as const) {
        const r = await c.pedir(metodo, ruta, { texto: 'alterado', valor: '10', actividad: 'tp1' });
        expect([404, 405], `${metodo} ${ruta}`).toContain(r.status);
      }
    }
    const e = await verEntregas(dueno, C.id);
    const original = e.json.entregas.find((x: any) => x.id === entrega);
    expect(original.texto).toBe('texto original');
    const h = await verHistorial(dueno, C.id);
    expect(h.json.notas.map((n: any) => n.valor)).toEqual(['6']);
    const b = await bajar(dueno, C.id, archivo);
    expect(b.texto).toBe('contenido original');
  });

  test('la base rechaza cambios y borrados sobre entregas, notas y archivos', async ({ nucleo }) => {
    const db = new DatabaseSync(nucleo.rutaBase);
    try {
      for (const sql of [
        `UPDATE entregas SET texto = 'alterado' WHERE id = ${entrega}`,
        `UPDATE entregas SET creada_en = '2020-01-01T00:00:00Z' WHERE id = ${entrega}`,
        `DELETE FROM entregas WHERE id = ${entrega}`,
        `UPDATE notas SET valor = '10' WHERE id = ${nota}`,
        `DELETE FROM notas WHERE id = ${nota}`,
        `UPDATE archivos SET sha256 = 'x' WHERE id = '${archivo}'`,
        `DELETE FROM archivos WHERE id = '${archivo}'`,
      ]) {
        expect(() => db.exec(sql), sql).toThrow();
      }
    } finally {
      db.close();
    }
    const fila = nucleo.consultar('SELECT texto FROM entregas WHERE id = ?', entrega)[0];
    expect(fila.texto).toBe('texto original');
    expect(nucleo.consultar('SELECT valor FROM notas WHERE id = ?', nota)[0].valor).toBe('6');
  });

  test('un cambio de nota agrega un registro nuevo y deja el anterior intacto', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_REDES);
    const n = await ponerNotaOk(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '9' });
    expect(n.id).not.toBe(nota);
    expect(n.anterior).toBe('6');
    const filas = nucleo.consultar('SELECT id, valor, anterior FROM notas WHERE curso_id = ? ORDER BY id', C.id);
    expect(filas.map((f: any) => [Number(f.id), f.valor, f.anterior])).toEqual([
      [nota, '6', null],
      [n.id, '9', '6'],
    ]);
  });

  test('si el archivo guardado se altera en el disco, la plataforma no lo sirve', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const otro = (await subirOk(alumno, C.id, 'alterable.txt', 'version buena')).id;
    const ruta = rutaArchivo(nucleo, C.id, otro);
    fs.chmodSync(ruta, 0o600);
    fs.writeFileSync(ruta, 'version mala!');
    const r = await bajar(alumno, C.id, otro);
    expect(r.status).toBe(500);
    expect(r.json?.error).toBe('archivo_alterado');
    expect(r.texto).not.toContain('version mala');
    fs.writeFileSync(ruta, 'version buen!');
    const r2 = await bajar(alumno, C.id, otro);
    expect(r2.status).toBe(500);
    expect(r2.texto).not.toContain('version buen!');
  });
});
