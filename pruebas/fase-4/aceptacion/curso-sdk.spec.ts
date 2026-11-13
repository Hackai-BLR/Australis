import crypto from 'node:crypto';
import { crearTestCursos, expect } from '../../fase-2/fixtures.ts';
import { nuevaSemilla } from '../../fase-2/lib/identidad.ts';
import { TIEMPO_PRUEBA_DOCKER, apiDeCurso, cursoListo, idAleatorio, inscribirOk, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { ALUMNA_REDES, ALUMNO_REDES, DUENO_REDES, PROFE_REDES } from '../fixtures.ts';
import { idUsuario, nombreUsuario, sesion, sha256, verEntregas, verHistorial } from '../lib/datos.ts';
import { cargarSdk, identidad } from '../lib/api-curso.ts';

const CLAVE = nuevaSemilla();
const test = crearTestCursos({ entorno: { IDENTIDAD_CLAVE_PRIVADA: CLAVE.semilla } });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let id = '';

test.describe('servicios de datos desde un curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const dueno = await sesion(nucleo, DUENO_REDES);
    id = idAleatorio('dat');
    await cursoListo(dueno, { id, nombre: `Datos ${id}` });
    await inscribirOk(dueno, id, [PROFE_REDES], 'profesor');
    await inscribirOk(dueno, id, [ALUMNO_REDES, ALUMNA_REDES]);
  });

  test('el SDK sube, entrega, pone notas y lee con la identidad de cada persona', async ({ nucleo }) => {
    const sdk = await cargarSdk();
    const cliente = new sdk.ClienteCampus({ api: apiDeCurso(nucleo, id), token: tokenDeCurso(nucleo, id) });
    const idAlumno = identidad(nucleo, CLAVE.privada, id, ALUMNO_REDES, 'alumno');
    const idAlumna = identidad(nucleo, CLAVE.privada, id, ALUMNA_REDES, 'alumno');
    const idProfe = identidad(nucleo, CLAVE.privada, id, PROFE_REDES, 'profesor');

    const contenido = crypto.randomBytes(10_000);
    const archivo = await cliente.subirArchivo(idAlumno, { nombre: 'tp1.zip', contenido });
    expect(archivo.nombre).toBe('tp1.zip');
    expect(archivo.sha256).toBe(sha256(contenido));
    expect(archivo.material).toBe(false);
    expect(String(archivo.usuario.id)).toBe(String(idUsuario(nucleo, ALUMNO_REDES)));

    const material = await cliente.subirArchivo(idProfe, { nombre: 'Consigna.pdf', contenido: new TextEncoder().encode('%PDF consigna'), material: true });
    expect(material.material).toBe(true);

    const entrega = await cliente.entregar(idAlumno, { actividad: 'tp1', texto: 'Mi entrega', archivoId: archivo.id });
    expect(entrega.via).toBe('curso');
    expect(entrega.actividad).toBe('tp1');
    expect(entrega.archivo.id).toBe(archivo.id);
    expect(String(entrega.usuario.id)).toBe(String(idUsuario(nucleo, ALUMNO_REDES)));
    await cliente.entregar(idAlumna, { actividad: 'tp1', texto: 'La de Sofía' });

    const propias = await cliente.entregas(idAlumno);
    expect(propias.map((e: any) => e.usuario.email)).toEqual([ALUMNO_REDES]);
    const todas = await cliente.entregas(idProfe, { actividad: 'tp1' });
    expect(new Set(todas.map((e: any) => e.usuario.email))).toEqual(new Set([ALUMNO_REDES, ALUMNA_REDES]));

    const bajado = await cliente.bajarArchivo(idProfe, archivo.id);
    expect(bajado.nombre).toBe('tp1.zip');
    expect(Buffer.from(bajado.contenido).equals(contenido)).toBe(true);

    const lista = await cliente.archivos(idAlumno);
    expect(lista.archivos.map((a: any) => a.id).sort()).toEqual([archivo.id, material.id].sort());
    expect(lista.cuota).toBe(1073741824);
    expect(lista.usado).toBe(contenido.length + '%PDF consigna'.length);

    const alumnoId = String(idUsuario(nucleo, ALUMNO_REDES));
    const n1 = await cliente.ponerNota(idProfe, { usuario: alumnoId, actividad: 'tp1', valor: '6' });
    expect(n1.via).toBe('curso');
    expect(n1.anterior).toBeNull();
    const n2 = await cliente.ponerNota(idProfe, { usuario: alumnoId, actividad: 'tp1', valor: '8', comentario: 'Mejor' });
    expect(n2.anterior).toBe('6');
    expect(n2.autor.nombre).toBe(nombreUsuario(nucleo, PROFE_REDES));

    const notas = await cliente.notas(idAlumno);
    expect(notas.map((n: any) => [n.actividad, n.valor])).toEqual([['tp1', '8']]);
    const historial = await cliente.historialNotas(idProfe, { usuario: alumnoId });
    expect(historial.map((n: any) => n.valor)).toEqual(['6', '8']);

    await expect(cliente.ponerNota(idAlumno, { usuario: alumnoId, actividad: 'tp1', valor: '10' })).rejects.toMatchObject({ name: 'ErrorApi', codigo: 'prohibido' });
    await expect(cliente.subirArchivo(idAlumno, { nombre: 'x.html', contenido: new TextEncoder().encode('<script>') })).rejects.toMatchObject({
      name: 'ErrorApi',
      codigo: 'tipo_no_permitido',
    });
    await expect(cliente.entregas('identidad-falsa')).rejects.toMatchObject({ name: 'ErrorApi', codigo: 'identidad_invalida' });

    const dueno = await sesion(nucleo, DUENO_REDES);
    const enPlataforma = await verEntregas(dueno, id, { actividad: 'tp1' });
    expect(enPlataforma.status).toBe(200);
    expect(enPlataforma.json.entregas.map((e: any) => e.via)).toEqual(['curso', 'curso']);
    const h = await verHistorial(dueno, id);
    expect(h.json.notas.map((n: any) => [n.valor, n.via])).toEqual([
      ['6', 'curso'],
      ['8', 'curso'],
    ]);
  });

  test('el ejemplo de la plantilla: el alumno entrega, el profesor ve y califica, el alumno ve su nota', async ({ nucleo, paginaComo }) => {
    const base = `http://${id}-curso.${nucleo.host().split(':')[0]}:${nucleo.puerto}`;
    const alumna = await sesion(nucleo, ALUMNA_REDES);
    const pAlumna = await paginaComo(alumna);
    await pAlumna.goto(`${base}/`);
    const seccion = pAlumna.locator('[data-prueba="entregas"]');
    await expect(seccion).toBeVisible({ timeout: 30_000 });
    const previas = await pAlumna.locator('[data-prueba="entrega"]').count();
    await pAlumna.locator('[data-prueba="entrega-actividad"]').fill('tp2');
    await pAlumna.locator('[data-prueba="entrega-texto"]').fill('Resolví los ejercicios');
    const contenido = Buffer.from(`ejercicios ${crypto.randomUUID()}`);
    await pAlumna.locator('[data-prueba="entrega-archivo"]').setInputFiles({ name: 'ejercicios.txt', mimeType: 'text/plain', buffer: contenido });
    await pAlumna.locator('[data-prueba="entrega-enviar"]').click();
    await expect(pAlumna.locator('[data-prueba="entrega"]')).toHaveCount(previas + 1);
    const fila = pAlumna.locator('[data-prueba="entrega"]', { hasText: 'ejercicios.txt' });
    await expect(fila).toHaveCount(1);
    await expect(fila).toHaveAttribute('data-actividad', 'tp2');
    const href = await fila.locator('[data-prueba="entrega-descarga"]').getAttribute('href');
    expect(href).toBeTruthy();
    const descarga = await pAlumna.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' });
      const bytes = new Uint8Array(await r.arrayBuffer());
      let binario = '';
      for (const b of bytes) binario += String.fromCharCode(b);
      return { status: r.status, cuerpo: btoa(binario), disposicion: r.headers.get('content-disposition') ?? '' };
    }, new URL(href!, `${base}/`).href);
    expect(descarga.status).toBe(200);
    expect(Buffer.from(descarga.cuerpo, 'base64').equals(contenido)).toBe(true);
    expect(descarga.disposicion).toMatch(/^attachment/);

    const profe = await sesion(nucleo, PROFE_REDES);
    const pProfe = await paginaComo(profe);
    await pProfe.goto(`${base}/`);
    const nombreAlumna = nombreUsuario(nucleo, ALUMNA_REDES);
    const filaProfe = pProfe.locator(`[data-prueba="entrega"][data-actividad="tp2"][data-usuario="${idUsuario(nucleo, ALUMNA_REDES)}"]`);
    await expect(filaProfe).toHaveCount(1, { timeout: 30_000 });
    await expect(filaProfe).toContainText(nombreAlumna);
    await expect(filaProfe).toContainText('ejercicios.txt');
    await filaProfe.locator('[data-prueba="nota-valor"]').fill('7');
    await filaProfe.locator('[data-prueba="nota-guardar"]').click();
    await expect(pProfe.locator('[data-prueba="nota-historial"]', { hasText: nombreAlumna })).toHaveCount(1);
    await filaProfe.locator('[data-prueba="nota-valor"]').fill('9');
    await filaProfe.locator('[data-prueba="nota-guardar"]').click();
    const historial = pProfe.locator('[data-prueba="nota-historial"]', { hasText: nombreAlumna });
    await expect(historial).toHaveCount(2);
    await expect(historial.last()).toContainText('9');
    await expect(historial.last()).toContainText(nombreUsuario(nucleo, PROFE_REDES));

    const pAlumna2 = await paginaComo(alumna);
    await pAlumna2.goto(`${base}/`);
    const nota = pAlumna2.locator('[data-prueba="nota"][data-actividad="tp2"]');
    await expect(nota).toHaveCount(1, { timeout: 30_000 });
    await expect(nota).toContainText('9');
    await expect(pAlumna2.locator('[data-prueba="nota-historial"]')).toHaveCount(0);
    await expect(pAlumna2.locator('[data-prueba="entrega"]', { hasText: 'La de Sofía' })).toHaveCount(1);
    await expect(pAlumna2.locator('[data-prueba="entrega"]', { hasText: 'Mi entrega' })).toHaveCount(0);

    const dueno = await sesion(nucleo, DUENO_REDES);
    const r = await verEntregas(dueno, id, { actividad: 'tp2' });
    expect(r.json.entregas).toHaveLength(1);
    expect(r.json.entregas[0].via).toBe('curso');
    expect(r.json.entregas[0].archivo.sha256).toBe(sha256(contenido));
  });
});
