import { Cliente } from '../../comun/http.ts';
import { ALUMNA_REDES, ALUMNO_REDES, DUENO_REDES, PROFE_REDES, MIEMBROS_REDES, crearTestDatos, expect } from '../fixtures.ts';
import {
  bajar,
  entregarOk,
  fechaEnRango,
  idUsuario,
  nombreUsuario,
  ponerNotaOk,
  sesion,
  sha256,
  subirOk,
  verEntregas,
  verHistorial,
  verNotas,
  cursoAislado,
} from '../lib/datos.ts';

const test = crearTestDatos();
const C = { id: '' };
test.beforeAll(({ nucleo }) => {
  C.id = cursoAislado(nucleo, 'ent', MIEMBROS_REDES);
});
test.describe.configure({ mode: 'serial' });

test.describe('registro de entregas y de notas', () => {
  test('un alumno entrega un archivo y un texto, y la plataforma registra quién, qué y cuándo', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const contenido = Buffer.from('captura de Wireshark');
    const archivo = await subirOk(alumno, C.id, 'captura.pcap.txt', contenido);
    const antes = Date.now();
    const e = await entregarOk(alumno, C.id, { actividad: 'tp1', texto: 'Adjunto la captura', archivo_id: archivo.id });
    const despues = Date.now();
    expect(typeof e.id).toBe('number');
    expect(e.actividad).toBe('tp1');
    expect(e.texto).toBe('Adjunto la captura');
    expect(e.via).toBe('plataforma');
    expect(e.archivo.id).toBe(archivo.id);
    expect(e.archivo.nombre).toBe('captura.pcap.txt');
    expect(e.archivo.sha256).toBe(sha256(contenido));
    expect(String(e.usuario.id)).toBe(String(idUsuario(nucleo, ALUMNO_REDES)));
    expect(e.usuario.email).toBe(ALUMNO_REDES);
    expect(e.usuario.nombre).toBe(nombreUsuario(nucleo, ALUMNO_REDES));
    fechaEnRango(e.fecha, antes, despues);

    const soloTexto = await entregarOk(alumno, C.id, { actividad: 'tp2', texto: 'Respuesta en texto' });
    expect(soloTexto.archivo).toBeNull();
    const soloArchivo = await entregarOk(alumno, C.id, { actividad: 'tp1', archivo_id: archivo.id });
    expect(soloArchivo.texto).toBeNull();
    expect(soloArchivo.id).toBeGreaterThan(e.id);
  });

  test('el alumno ve solo sus entregas; dueño y profesores ven todas las del curso', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const alumna = await sesion(nucleo, ALUMNA_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    const profe = await sesion(nucleo, PROFE_REDES);
    const deElla = await entregarOk(alumna, C.id, { actividad: 'tp1', texto: 'Entrega de Sofía' });

    const propias = await verEntregas(alumno, C.id);
    expect(propias.status).toBe(200);
    expect(propias.json.entregas.length).toBeGreaterThanOrEqual(3);
    for (const x of propias.json.entregas) expect(x.usuario.email).toBe(ALUMNO_REDES);
    const ids = propias.json.entregas.map((x: any) => x.id);
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual(ids);

    const deSofia = await verEntregas(alumna, C.id);
    expect(deSofia.json.entregas.map((x: any) => x.id)).toEqual([deElla.id]);

    for (const docente of [dueno, profe]) {
      const todas = await verEntregas(docente, C.id);
      expect(todas.status).toBe(200);
      const mails = new Set(todas.json.entregas.map((x: any) => x.usuario.email));
      expect(mails.has(ALUMNO_REDES)).toBe(true);
      expect(mails.has(ALUMNA_REDES)).toBe(true);
      const tp1 = await verEntregas(docente, C.id, { actividad: 'tp1' });
      expect(tp1.json.entregas.length).toBeGreaterThanOrEqual(3);
      for (const x of tp1.json.entregas) expect(x.actividad).toBe('tp1');
      const deUno = await verEntregas(docente, C.id, { usuario: idUsuario(nucleo, ALUMNA_REDES) });
      expect(deUno.json.entregas.map((x: any) => x.id)).toEqual([deElla.id]);
    }

    const conArchivo = (await verEntregas(profe, C.id, { usuario: idUsuario(nucleo, ALUMNO_REDES) })).json.entregas.find((x: any) => x.archivo);
    const b = await bajar(profe, C.id, conArchivo.archivo.id);
    expect(b.status).toBe(200);
    expect(b.texto).toBe('captura de Wireshark');
  });

  test('un profesor pone una nota, la cambia y queda el historial con quién, cuándo y el valor anterior', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    const alumnoId = idUsuario(nucleo, ALUMNO_REDES);
    const antes = Date.now();
    const n1 = await ponerNotaOk(profe, C.id, { usuario_id: alumnoId, actividad: 'tp1', valor: '7', comentario: 'Falta el análisis' });
    expect(n1.valor).toBe('7');
    expect(n1.anterior).toBeNull();
    expect(n1.comentario).toBe('Falta el análisis');
    expect(n1.via).toBe('plataforma');
    expect(String(n1.usuario.id)).toBe(String(alumnoId));
    expect(n1.autor.nombre).toBe(nombreUsuario(nucleo, PROFE_REDES));
    expect(String(n1.autor.id)).toBe(String(idUsuario(nucleo, PROFE_REDES)));
    fechaEnRango(n1.fecha, antes, Date.now());

    const n2 = await ponerNotaOk(dueno, C.id, { usuario_id: String(alumnoId), actividad: 'tp1', valor: ' 8.5 ' });
    expect(n2.valor).toBe('8.5');
    expect(n2.anterior).toBe('7');
    expect(n2.comentario).toBeNull();
    expect(n2.autor.nombre).toBe(nombreUsuario(nucleo, DUENO_REDES));
    expect(n2.id).toBeGreaterThan(n1.id);

    await ponerNotaOk(profe, C.id, { usuario_id: idUsuario(nucleo, ALUMNA_REDES), actividad: 'tp1', valor: 'Aprobado' });

    const h = await verHistorial(profe, C.id, { usuario: alumnoId, actividad: 'tp1' });
    expect(h.status).toBe(200);
    expect(h.json.notas.map((x: any) => [x.valor, x.anterior, x.autor.nombre])).toEqual([
      ['7', null, nombreUsuario(nucleo, PROFE_REDES)],
      ['8.5', '7', nombreUsuario(nucleo, DUENO_REDES)],
    ]);
    const todo = await verHistorial(dueno, C.id);
    expect(todo.json.notas.length).toBe(3);

    const vigentes = await verNotas(profe, C.id, { actividad: 'tp1' });
    expect(vigentes.status).toBe(200);
    const porMail = Object.fromEntries(vigentes.json.notas.map((x: any) => [x.usuario.email, x.valor]));
    expect(porMail).toEqual({ [ALUMNO_REDES]: '8.5', [ALUMNA_REDES]: 'Aprobado' });
  });

  test('el alumno ve solo sus notas vigentes, sin el historial', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const r = await verNotas(alumno, C.id);
    expect(r.status).toBe(200);
    expect(r.json.notas).toHaveLength(1);
    const n = r.json.notas[0];
    expect(n.actividad).toBe('tp1');
    expect(n.valor).toBe('8.5');
    expect(n.usuario.email).toBe(ALUMNO_REDES);
    expect(n).not.toHaveProperty('anterior');
    expect(JSON.stringify(r.json)).not.toContain('Aprobado');
    expect(JSON.stringify(r.json)).not.toContain('"7"');
  });

});
