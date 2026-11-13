import zlib from 'node:zlib';

const FINAL = 0xfffffffe;
const LIBRE = 0xffffffff;
const SECTOR_FAT = 0xfffffffd;

function registro(tipo: number, datos: Buffer): Buffer {
  const cab = Buffer.alloc(4);
  cab.writeUInt16LE(tipo, 0);
  cab.writeUInt16LE(datos.length, 2);
  return Buffer.concat([cab, datos]);
}

function bof(tipo: number): Buffer {
  const d = Buffer.alloc(16);
  d.writeUInt16LE(0x0600, 0);
  d.writeUInt16LE(tipo, 2);
  d.writeUInt16LE(0x0dbb, 4);
  d.writeUInt16LE(0x07cc, 6);
  d.writeUInt32LE(0, 8);
  d.writeUInt32LE(0x06, 12);
  return registro(0x0809, d);
}

function eof(): Buffer {
  return registro(0x000a, Buffer.alloc(0));
}

function etiqueta(fila: number, col: number, texto: string): Buffer {
  const chars = Buffer.from(texto, 'utf16le');
  const d = Buffer.alloc(9);
  d.writeUInt16LE(fila, 0);
  d.writeUInt16LE(col, 2);
  d.writeUInt16LE(0, 4);
  d.writeUInt16LE(texto.length, 6);
  d.writeUInt8(1, 8);
  return registro(0x0204, Buffer.concat([d, chars]));
}

function dimensiones(filas: number, cols: number): Buffer {
  const d = Buffer.alloc(14);
  d.writeUInt32LE(0, 0);
  d.writeUInt32LE(filas, 4);
  d.writeUInt16LE(0, 8);
  d.writeUInt16LE(cols, 10);
  return registro(0x0200, d);
}

function hojaLigada(posicion: number, nombre: string): Buffer {
  const n = Buffer.from(nombre, 'latin1');
  const d = Buffer.alloc(8);
  d.writeUInt32LE(posicion, 0);
  d.writeUInt8(0, 4);
  d.writeUInt8(0, 5);
  d.writeUInt8(n.length, 6);
  d.writeUInt8(0, 7);
  return registro(0x0085, Buffer.concat([d, n]));
}

interface Celda {
  fila: number;
  col: number;
  texto: string;
}

function libroBiff(celdas: Celda[], hojas = 1, dims?: { filas: number; cols: number }): Buffer {
  const largoHojaLigada = (i: number) => 4 + 8 + `Hoja${i + 1}`.length;
  let largoGlobales = bof(0x0005).length + eof().length;
  for (let i = 0; i < hojas; i++) largoGlobales += largoHojaLigada(i);
  const globales = [bof(0x0005)];
  for (let i = 0; i < hojas; i++) globales.push(hojaLigada(largoGlobales, `Hoja${i + 1}`));
  globales.push(eof());
  const hoja = [bof(0x0010)];
  if (dims) hoja.push(dimensiones(dims.filas, dims.cols));
  for (const c of celdas) hoja.push(etiqueta(c.fila, c.col, c.texto));
  hoja.push(eof());
  return Buffer.concat([...globales, ...hoja]);
}

function cfb(libro: Buffer): Buffer {
  const datos = Buffer.alloc(Math.max(4096, Math.ceil(libro.length / 512) * 512));
  libro.copy(datos);
  const sectoresLibro = datos.length / 512;
  if (sectoresLibro + 2 > 128) throw new Error('Libro demasiado grande para el armado de prueba');
  const cab = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cab, 0);
  cab.writeUInt16LE(0x003e, 24);
  cab.writeUInt16LE(3, 26);
  cab.writeUInt16LE(0xfffe, 28);
  cab.writeUInt16LE(9, 30);
  cab.writeUInt16LE(6, 32);
  cab.writeUInt32LE(0, 40);
  cab.writeUInt32LE(1, 44);
  cab.writeUInt32LE(1, 48);
  cab.writeUInt32LE(0, 52);
  cab.writeUInt32LE(4096, 56);
  cab.writeUInt32LE(FINAL, 60);
  cab.writeUInt32LE(0, 64);
  cab.writeUInt32LE(FINAL, 68);
  cab.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) cab.writeUInt32LE(i === 0 ? 0 : LIBRE, 76 + i * 4);
  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(SECTOR_FAT, 0);
  fat.writeUInt32LE(FINAL, 4);
  for (let i = 0; i < sectoresLibro; i++) fat.writeUInt32LE(i === sectoresLibro - 1 ? FINAL : 3 + i, (2 + i) * 4);
  const dir = Buffer.alloc(512);
  const entrada = (i: number, nombre: string, tipo: number, hijo: number, inicio: number, largo: number) => {
    const o = i * 128;
    const n = Buffer.from(nombre + '\u0000', 'utf16le');
    n.copy(dir, o);
    dir.writeUInt16LE(n.length, o + 64);
    dir.writeUInt8(tipo, o + 66);
    dir.writeUInt8(1, o + 67);
    dir.writeUInt32LE(LIBRE, o + 68);
    dir.writeUInt32LE(LIBRE, o + 72);
    dir.writeUInt32LE(hijo, o + 76);
    dir.writeUInt32LE(inicio, o + 116);
    dir.writeUInt32LE(largo, o + 120);
  };
  entrada(0, 'Root Entry', 5, 1, FINAL, 0);
  entrada(1, 'Workbook', 2, LIBRE, 2, datos.length);
  for (const i of [2, 3]) {
    dir.writeUInt32LE(LIBRE, i * 128 + 68);
    dir.writeUInt32LE(LIBRE, i * 128 + 72);
    dir.writeUInt32LE(LIBRE, i * 128 + 76);
  }
  return Buffer.concat([cab, fat, dir, datos]);
}

export function crearXls(filas: string[][]): Buffer {
  const celdas: Celda[] = [];
  filas.forEach((f, i) => f.forEach((texto, j) => celdas.push({ fila: i, col: j, texto })));
  return cfb(libroBiff(celdas));
}

export function crearXlsGigante(hojas = 12): Buffer {
  return cfb(
    libroBiff(
      [
        { fila: 0, col: 0, texto: 'mail' },
        { fila: 65535, col: 255, texto: 'x' },
      ],
      hojas,
      { filas: 65536, cols: 256 },
    ),
  );
}

interface Entrada {
  nombre: string;
  comprimido: Buffer;
  crc: number;
  largo: number;
}

function zipCrudo(entradas: Entrada[]): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let desplazamiento = 0;
  for (const a of entradas) {
    const nombre = Buffer.from(a.nombre, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(a.crc, 14);
    local.writeUInt32LE(a.comprimido.length, 18);
    local.writeUInt32LE(a.largo, 22);
    local.writeUInt16LE(nombre.length, 26);
    locales.push(local, nombre, a.comprimido);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(a.crc, 16);
    central.writeUInt32LE(a.comprimido.length, 20);
    central.writeUInt32LE(a.largo, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(desplazamiento, 42);
    centrales.push(central, nombre);
    desplazamiento += local.length + nombre.length + a.comprimido.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...locales, dir, fin]);
}

function entrada(nombre: string, texto: string): Entrada {
  const datos = Buffer.from(texto, 'utf8');
  return { nombre, comprimido: zlib.deflateRawSync(datos), crc: zlib.crc32(datos) >>> 0, largo: datos.length };
}

async function entradaRepetida(nombre: string, inicio: string, relleno: string, megas: number, fin: string): Promise<Entrada> {
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const partes: Buffer[] = [];
  deflate.on('data', (p: Buffer) => partes.push(p));
  const listo = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const cab = Buffer.from(inicio, 'utf8');
  const bloque = Buffer.alloc(1024 * 1024, relleno);
  const cola = Buffer.from(fin, 'utf8');
  let crc = zlib.crc32(cab);
  const escribir = (b: Buffer) =>
    new Promise<void>((resolve) => {
      if (deflate.write(b)) resolve();
      else deflate.once('drain', () => resolve());
    });
  await escribir(cab);
  for (let i = 0; i < megas; i++) {
    crc = zlib.crc32(bloque, crc);
    await escribir(bloque);
  }
  crc = zlib.crc32(cola, crc);
  await escribir(cola);
  deflate.end();
  await listo;
  return { nombre, comprimido: Buffer.concat(partes), crc: crc >>> 0, largo: cab.length + megas * bloque.length + cola.length };
}

const TIPOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const LIBRO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inscriptos" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const LIBRO_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

function hoja(celdas: Array<{ ref: string; indice: number }>) {
  const porFila = new Map<string, string[]>();
  for (const c of celdas) {
    const fila = c.ref.replace(/^[A-Z]+/, '');
    porFila.set(fila, [...(porFila.get(fila) ?? []), `<c r="${c.ref}" t="s"><v>${c.indice}</v></c>`]);
  }
  const filas = [...porFila].map(([f, cs]) => `<row r="${f}">${cs.join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${filas}</sheetData></worksheet>`;
}

function compartidas(textos: string[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${textos.length}" uniqueCount="${textos.length}">${textos
    .map((t) => `<si><t>${t}</t></si>`)
    .join('')}</sst>`;
}

export function crearXlsxEsquinaLejana(): Buffer {
  return zipCrudo([
    entrada('[Content_Types].xml', TIPOS),
    entrada('_rels/.rels', RELS),
    entrada('xl/workbook.xml', LIBRO),
    entrada('xl/_rels/workbook.xml.rels', LIBRO_RELS),
    entrada('xl/worksheets/sheet1.xml', hoja([{ ref: 'A1', indice: 0 }, { ref: 'XFD1048576', indice: 1 }])),
    entrada('xl/sharedStrings.xml', compartidas(['mail', 'x'])),
  ]);
}

export async function crearXlsxBombaCompartidas(megas = 700): Promise<Buffer> {
  const sst = await entradaRepetida(
    'xl/sharedStrings.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>mail</t></si><si><t>',
    'a',
    megas,
    '</t></si></sst>',
  );
  return zipCrudo([
    entrada('[Content_Types].xml', TIPOS),
    entrada('_rels/.rels', RELS),
    entrada('xl/workbook.xml', LIBRO),
    entrada('xl/_rels/workbook.xml.rels', LIBRO_RELS),
    entrada('xl/worksheets/sheet1.xml', hoja([{ ref: 'A1', indice: 0 }, { ref: 'A2', indice: 1 }])),
    sst,
  ]);
}
