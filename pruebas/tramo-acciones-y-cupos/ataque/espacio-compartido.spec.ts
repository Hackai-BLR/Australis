import { crearTestAcciones, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { inscribirOk } from '../../fase-2/lib/cursos.ts';
import { docker, ejecutarEn } from '../../fase-2/lib/docker.ts';
import { cursoConEspacio, entornoEspacio, nombreEspacio, pedidoOk, guion } from '../../fase-3/lib/agente.ts';
import { PRELUDIO_SCRIPT, correrScript, resultado, sesionDe } from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let duena: Cliente;
let profe: Cliente;

const VIGIA = String.raw`
const fs = require('fs');
const propio = String(process.pid);
const salida = process.argv[1];
const vistos = new Set();
const fin = Date.now() + Number(process.argv[2]);
const patron = /(?:cat|cmt|cct)_[A-Za-z0-9_-]{43}/g;
fs.writeFileSync(salida, 'VIGIA ' + propio + '\n');
function ronda() {
  let lista = [];
  try { lista = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p) && p !== propio); } catch {}
  for (const p of lista) {
    for (const archivo of ['environ', 'cmdline']) {
      let texto = '';
      try { texto = fs.readFileSync('/proc/' + p + '/' + archivo, 'latin1'); } catch { continue; }
      for (const m of texto.match(patron) ?? []) {
        let cmd = '';
        try { cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'latin1').split('\0').join(' ').slice(0, 120); } catch {}
        const clave = m + ' ' + archivo + ' ' + cmd;
        if (!vistos.has(clave)) {
          vistos.add(clave);
          fs.appendFileSync(salida, 'HALLADO ' + archivo + ' ' + m + ' [' + cmd + ']\n');
        }
      }
    }
  }
  if (Date.now() < fin) setTimeout(ronda, 5);
  else fs.appendFileSync(salida, 'TERMINADO\n');
}
ronda();
`;

function lanzarVigia(espacio: string, archivo: string, ms: number) {
  const r = docker(
    ['exec', '-d', '-e', 'ANTHROPIC_AUTH_TOKEN=', '-e', 'CAMPUSIA_TOKEN_CURSO=', '-e', 'CAMPUSIA_CLAVE_PUBLICA=', espacio, 'node', '-e', VIGIA, archivo, String(ms)],
    true,
  );
  expect(r.estado, r.error).toBe(0);
}

async function leerVigia(espacio: string, archivo: string, esperarFin: boolean): Promise<string> {
  const limite = Date.now() + 120_000;
  let texto = '';
  while (Date.now() < limite) {
    texto = docker(['exec', '-e', 'ANTHROPIC_AUTH_TOKEN=', '-e', 'CAMPUSIA_TOKEN_CURSO=', espacio, 'cat', archivo], true).salida;
    if (!esperarFin || texto.includes('TERMINADO')) return texto;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return texto;
}

function hallazgos(texto: string, tokens: string[]): string[] {
  return texto
    .split('\n')
    .filter((l) => l.startsWith('HALLADO '))
    .filter((l) => tokens.some((t) => l.includes(t)) || /\b(cat|cmt)_/.test(l));
}

test.describe('el código del curso no se queda con los tokens del agente ni del modelo', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    profe = await sesionDe(nucleo, PROFE2_AUSTRAL);
    id = await cursoConEspacio(duena, { nombre: 'Curso Compartido' });
    await inscribirOk(duena, id, [PROFE2_AUSTRAL], 'profesor');
    await inscribirOk(duena, id, [ALUMNO_AUSTRAL]);
  });

  test('un proceso del curso que recorre /proc no ve el token del agente del dueño ni el del modelo', async ({ nucleo }) => {
    const espacio = nombreEspacio(nucleo, id);
    const cmt = String(entornoEspacio(nucleo, id).ANTHROPIC_AUTH_TOKEN);
    expect(cmt).toMatch(/^cmt_/);
    const archivo = `/tmp/vigia-${aleatorio('v').toLowerCase().replace(/[^a-z0-9]/g, '')}.txt`;

    const plantado = await correrScript(
      nucleo,
      profe,
      id,
      `await intentar('lista', () => c.listarInscriptos());`,
      { pedido: 'Dejá corriendo un vigía en el servidor' },
    );
    expect(resultado(plantado, 'lista').ok).toBe(true);

    lanzarVigia(espacio, archivo, 90_000);
    expect(await leerVigia(espacio, archivo, false)).toContain('VIGIA');

    const nombre = aleatorio('vig').toLowerCase().replace(/[^a-z0-9]/g, '');
    const script = `acciones-prueba/${nombre}.mjs`;
    const nuevo = `${aleatorio('cv.')}@mail.austral.edu.ar`;
    guion(nucleo, nombre, [
      {
        herramientas: [
          {
            nombre: 'Write',
            entrada: { file_path: `/repo/${script}`, content: `${PRELUDIO_SCRIPT}\nawait intentar('inscribir', () => c.inscribir(['${nuevo}']));\nawait new Promise((r) => setTimeout(r, 1500));\n` },
          },
        ],
      },
      { herramientas: [{ nombre: 'Bash', entrada: { command: `node ${script}`, description: 'Inscribe' } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: 'sleep 4; ls -la acciones-prueba | head -n 3; cat package.json | head -n 2', description: 'Mira' } }] },
      { herramientas: [{ nombre: 'Grep', entrada: { pattern: 'clienteDesdeEntorno', path: '/repo' } }] },
      { herramientas: [{ nombre: 'Glob', entrada: { pattern: '**/*.mjs' } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: `node ${script} | tail -n 5; sleep 3`, description: 'Repite' } }] },
      { texto: 'Listo.' },
    ]);
    const desde = nucleo.modelo.pedidos.length;
    const { respuesta } = await pedidoOk(duena, id, `Inscribí y revisá el repo [guion:${nombre}]`);
    expect(respuesta.estado).toBe('ok');
    const cuerpos = nucleo.modelo.pedidos
      .slice(desde)
      .map((p) => p.cuerpo)
      .join('\n');
    expect(cuerpos, 'el script del agente tenía que poder inscribir con su token').toMatch(/RESULTADO \{\\?"clave\\?":\\?"inscribir\\?",\\?"valor\\?":\{\\?"ok\\?":true/);

    const visto = await leerVigia(espacio, archivo, true);
    expect(visto).toContain('TERMINADO');
    expect(hallazgos(visto, [cmt]), visto.slice(0, 4000)).toEqual([]);
    expect(visto).not.toContain(cmt);
    expect(visto).not.toMatch(/cat_[A-Za-z0-9_-]{43}/);
  });

  test('el proceso 1 del espacio y los procesos que lanza el núcleo no dejan leer el token del modelo', async ({ nucleo }) => {
    const espacio = nombreEspacio(nucleo, id);
    const cmt = String(entornoEspacio(nucleo, id).ANTHROPIC_AUTH_TOKEN);
    const leido = docker(['exec', '-e', 'ANTHROPIC_AUTH_TOKEN=', espacio, 'node', '-e', "try{process.stdout.write(require('fs').readFileSync('/proc/1/environ','latin1'))}catch(e){console.log('ERROR '+e.code)}"], true);
    expect(leido.salida).toContain('ERROR');
    expect(leido.salida).not.toContain(cmt);
    const binarios = ejecutarEn(espacio, [
      'node',
      '-e',
      "const fs=require('fs');const malos=[];for(const d of ['/usr/bin','/usr/sbin','/usr/local/bin']){for(const f of fs.readdirSync(d)){if(/\\.so(\\.|$)/.test(f))continue;const p=d+'/'+f;let st;try{st=fs.statSync(p)}catch{continue}if(!st.isFile()||!(st.mode&0o111))continue;let fd;try{fd=fs.openSync(p,'r')}catch{continue}const b=Buffer.alloc(4);fs.readSync(fd,b,0,4,0);fs.closeSync(fd);if(b.toString('latin1')==='\\x7fELF')malos.push(p)}}console.log(JSON.stringify(malos))",
    ]);
    expect(JSON.parse(binarios.salida || '[]'), 'programas del sistema legibles: sus procesos se pueden volcar').toEqual([]);
  });
});
