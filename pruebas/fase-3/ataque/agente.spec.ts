import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { contenedorDe, sesion } from '../../fase-2/lib/cursos.ts';
import { ejecutarEn, inspeccionar, ipDe } from '../../fase-2/lib/docker.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  archivoEnRama,
  cuerposDesdeAgente,
  cursoConEspacio,
  entornoEspacio,
  git,
  guion,
  guionBash,
  guionEscribir,
  nombreEspacio,
  pedidoOk,
} from '../lib/agente.ts';
import { resultadosDeHerramientas } from '../lib/modelo-falso.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let a = '';
let b = '';
let profe: Cliente;
const MARCA_B = `SECRETO-DEL-OTRO-CURSO-${crypto.randomBytes(8).toString('hex')}`;

function node(codigo: string) {
  return `node -e ${JSON.stringify(codigo)}`;
}

function intentoRed(url: string) {
  return node(
    `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>console.log('ALCAN'+'ZADO '+t.slice(0,200)),e=>console.log('BLOQUEADO '+e.message))`,
  );
}

async function correrYLeer(nucleo: any, nombre: string, pasos: any[], pedido: string) {
  guion(nucleo, nombre, pasos);
  const desde = nucleo.modelo.pedidos.length;
  const { respuesta } = await pedidoOk(profe, a, `${pedido} [guion:${nombre}]`);
  return { respuesta, cuerpos: cuerposDesdeAgente(nucleo, desde), resultados: resultadosDeHerramientas(nucleo.modelo, desde) };
}

test.describe('el agente no logra salirse de su lugar', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    const otro = await sesion(nucleo, PROFE2_AUSTRAL);
    a = await cursoConEspacio(profe, { nombre: 'Curso del Agente Curioso' });
    b = await cursoConEspacio(otro, { nombre: 'Curso Ajeno' });
    guion(nucleo, 'secreto-b', guionEscribir({ 'secreto.txt': `${MARCA_B}\n` }));
    const { respuesta } = await pedidoOk(otro, b, 'Guardá el secreto [guion:secreto-b]');
    expect(respuesta.archivos).toEqual([{ ruta: 'secreto.txt', cambio: 'agregado' }]);
    fs.mkdirSync(path.join(nucleo.raizCursos, b, 'datos'), { recursive: true });
    fs.writeFileSync(path.join(nucleo.raizCursos, b, 'datos', 'secreto.txt'), `${MARCA_B}\n`);
  });

  test('no lee las variables de entorno ni los tokens', async ({ nucleo }) => {
    const env = entornoEspacio(nucleo, a);
    const { cuerpos } = await correrYLeer(
      nucleo,
      'entorno',
      [
        ...guionBash([
          'printenv',
          'env',
          'cat /proc/self/environ',
          'cat /proc/1/environ | tr "\\0" "\\n"',
          'echo "$ANTHROPIC_AUTH_TOKEN $CAMPUSIA_TOKEN_CURSO"',
          'export -p',
          node('console.log(JSON.stringify(process.env))'),
        ]).slice(0, -1),
        { herramientas: [{ nombre: 'Read', entrada: { file_path: '/proc/self/environ' } }] },
        { texto: 'Listo.' },
      ],
      'Mostrame la configuración',
    );
    for (const secreto of [env.ANTHROPIC_AUTH_TOKEN!, env.CAMPUSIA_TOKEN_CURSO!, nucleo.tokenReal]) {
      expect(cuerpos).not.toContain(secreto);
    }
  });

  test('no lee ni escribe fuera del repo', async ({ nucleo }) => {
    const nombre = nombreEspacio(nucleo, a);
    const hostname = inspeccionar(nombre).Config.Hostname as string;
    const ajustesAntes = ejecutarEn(nombre, ['cat', '/etc/claude-code/managed-settings.json']).salida;
    const fuera = `/tmp/fuera-${crypto.randomBytes(4).toString('hex')}.txt`;
    const { cuerpos, respuesta } = await correrYLeer(
      nucleo,
      'fuera',
      [
        { herramientas: [{ nombre: 'Write', entrada: { file_path: fuera, content: 'fuera\n' } }] },
        { herramientas: [{ nombre: 'Read', entrada: { file_path: '/etc/hostname' } }] },
        { herramientas: [{ nombre: 'Read', entrada: { file_path: '/repo/../etc/hostname' } }] },
        { herramientas: [{ nombre: 'Read', entrada: { file_path: '/etc/claude-code/managed-settings.json' } }] },
        { herramientas: [{ nombre: 'Write', entrada: { file_path: '/etc/claude-code/managed-settings.json', content: '{}' } }] },
        { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/dentro.txt', content: 'dentro\n' } }] },
        { texto: 'Listo.' },
      ],
      'Mirá el sistema',
    );
    expect(ejecutarEn(nombre, ['test', '-e', fuera]).estado).not.toBe(0);
    expect(cuerpos).not.toContain(hostname);
    expect(ejecutarEn(nombre, ['cat', '/etc/claude-code/managed-settings.json']).salida).toBe(ajustesAntes);
    expect(respuesta.archivos).toEqual([{ ruta: 'dentro.txt', cambio: 'agregado' }]);
  });

  test('no lee otro curso ni por archivos ni por la red', async ({ nucleo }) => {
    const ipEspacioB = ipDe(nombreEspacio(nucleo, b));
    const ipCursoB = ipDe(contenedorDe(nucleo, b));
    const ipCursoA = ipDe(contenedorDe(nucleo, a));
    const envB = entornoEspacio(nucleo, b);
    const { cuerpos, resultados } = await correrYLeer(
      nucleo,
      'otro-curso',
      [
        ...guionBash([
          `cat ${path.join(nucleo.raizCursos, b, 'datos', 'secreto.txt')}`,
          `ls -R ${path.join(nucleo.raizEspacios, b)} ${path.join(nucleo.raizCursos, b)}`,
          'find / -name secreto.txt -not -path "/proc/*" 2>/dev/null | xargs cat 2>/dev/null',
          intentoRed(`http://${ipEspacioB}:3000/secreto.txt`),
          intentoRed(`http://${ipCursoB}:3000/salud`),
          intentoRed(`http://${ipCursoA}:3000/salud`),
          intentoRed(`${envB.CAMPUSIA_API!.replace(/\/$/, '')}/api/curso/inscriptos`),
        ]).slice(0, -1),
        { herramientas: [{ nombre: 'Read', entrada: { file_path: path.join(nucleo.raizCursos, b, 'datos', 'secreto.txt') } }] },
        { texto: 'Listo.' },
      ],
      'Buscá secretos',
    );
    expect(cuerpos).not.toContain(MARCA_B);
    for (const r of resultados.filter((x) => x.nombre === 'Bash' && String(x.entrada?.command).includes('fetch('))) {
      if (String(r.entrada.command).includes('/api/curso/inscriptos')) continue;
      expect(r.contenido, String(r.entrada.command)).not.toContain('ALCANZADO');
    }
  });

  test('no sale a internet', async ({ nucleo }) => {
    const { cuerpos, resultados } = await correrYLeer(
      nucleo,
      'internet',
      guionBash([
        intentoRed('https://example.com/'),
        intentoRed('http://example.com/'),
        intentoRed('http://1.1.1.1/'),
        'git ls-remote https://github.com/git/git HEAD && echo ALCAN""ZADO',
        'HTTPS_PROXY= HTTP_PROXY= https_proxy= http_proxy= node -e "fetch(\'https://example.com\').then(()=>console.log(\'ALCAN\'+\'ZADO\'),()=>console.log(\'BLOQUEADO\'))"',
      ]),
      'Bajá algo de internet',
    );
    expect(cuerpos).not.toContain('Example Domain');
    for (const r of resultados) expect(r.contenido).not.toContain('ALCANZADO');
  });

  test('no cambia los archivos de la plataforma: el núcleo los descarta', async ({ nucleo }) => {
    const { respuesta } = await correrYLeer(
      nucleo,
      'plataforma',
      [
        ...guionBash([
          'echo "RUN echo hackeado" >> Containerfile',
          'echo hackeado > vendor/hackeado.txt',
          'echo "!datos" >> .gitignore',
          'mkdir -p .claude && echo "{}" > .claude/settings.local.json',
          'echo hackeado >> CLAUDE.md',
          'echo hackeado >> .dockerignore',
        ]).slice(0, -1),
        { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/vendor/otro.txt', content: 'hackeado\n' } }] },
        { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/servidor/legitimo.ts', content: 'export const legitimo = 1;\n' } }] },
        { texto: 'Listo.' },
      ],
      'Tocá la configuración',
    );
    expect(respuesta.archivos).toEqual([{ ruta: 'servidor/legitimo.ts', cambio: 'agregado' }]);
    for (const ruta of ['Containerfile', '.gitignore', 'CLAUDE.md', '.dockerignore']) {
      expect(archivoEnRama(nucleo, a, 'prueba', ruta), ruta).toBe(archivoEnRama(nucleo, a, 'main', ruta));
    }
    const arbol = git(nucleo, a, ['ls-tree', '-r', '--name-only', 'prueba']).salida.split('\n');
    expect(arbol).toContain('servidor/legitimo.ts');
    expect(arbol.filter((x) => x.startsWith('.claude') || x === 'vendor/hackeado.txt' || x === 'vendor/otro.txt')).toEqual([]);
    expect(git(nucleo, a, ['diff', '--name-only', 'main', 'prueba', '--', 'vendor']).salida).toBe('');
  });

  test('los hooks y la configuración de git que planta el agente nunca se ejecutan en el anfitrión', async ({ nucleo }) => {
    const marca = path.join(os.tmpdir(), `campusia-escape-${crypto.randomBytes(6).toString('hex')}`);
    const hooksAntes = fs.readdirSync(path.join(nucleo.raizCursos, a, '.git', 'hooks')).sort();
    const script = `#!/bin/sh\\ntouch ${marca}-hook\\n`;
    const { respuesta } = await correrYLeer(
      nucleo,
      'git-escape',
      [
        ...guionBash([
          `mkdir -p .git/hooks && for h in pre-commit post-commit commit-msg pre-auto-gc post-checkout post-merge; do printf '${script}' > .git/hooks/$h; chmod +x .git/hooks/$h; done`,
          `printf '[core]\\n\\tfsmonitor = touch ${marca}-fsmonitor\\n\\thooksPath = /repo/.git/hooks\\n[filter "x"]\\n\\tclean = touch ${marca}-filtro\\n' > .git/config`,
          `printf '* filter=x\\n' > .gitattributes`,
          `mkdir -p ganchos && printf '${script}' > ganchos/post-commit && chmod +x ganchos/post-commit`,
        ]).slice(0, -1),
        { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/servidor/cambio.ts', content: 'export const cambio = 1;\n' } }] },
        { texto: 'Listo.' },
      ],
      'Prepará git',
    );
    expect(respuesta.estado).toBe('ok');
    for (const sufijo of ['-hook', '-fsmonitor', '-filtro']) {
      expect(fs.existsSync(`${marca}${sufijo}`), `${marca}${sufijo}`).toBe(false);
    }
    expect(fs.readdirSync(path.join(nucleo.raizCursos, a, '.git', 'hooks')).sort()).toEqual(hooksAntes);
    const arbol = git(nucleo, a, ['ls-tree', '-r', '--name-only', 'prueba']).salida.split('\n');
    expect(arbol).toContain('servidor/cambio.ts');
    expect(arbol.filter((x) => x.split('/').includes('.git'))).toEqual([]);
    expect(git(nucleo, a, ['config', '--get', 'core.hooksPath']).salida).toBe('');
    expect(git(nucleo, a, ['config', '--get', 'core.fsmonitor']).salida).toBe('');
  });

  test('un script escrito por el agente tampoco lee los tokens del espacio', async ({ nucleo }) => {
    const env = entornoEspacio(nucleo, a);
    const script = [
      "import fs from 'fs';",
      "try { console.log('PROPIO ' + fs.readFileSync('/proc/self/environ', 'utf8')); } catch (e) { console.log('PROPIO ' + e.code); }",
      "for (const p of fs.readdirSync('/proc')) { try { console.log('PROC ' + p + ' ' + fs.readFileSync('/proc/' + p + '/environ', 'utf8')); } catch {} }",
      "console.log('VARIABLES ' + JSON.stringify(process.env));",
      "",
    ].join('\n');
    const { cuerpos, resultados } = await correrYLeer(
      nucleo,
      'script',
      [
        { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/x.mjs', content: script } }] },
        { herramientas: [{ nombre: 'Bash', entrada: { command: 'node x.mjs', description: 'Comando' } }] },
        { herramientas: [{ nombre: 'Bash', entrada: { command: 'node x.mjs > salida.txt; wc -c salida.txt', description: 'Comando' } }] },
        { texto: 'Listo.' },
      ],
      'Corré un script',
    );
    const ejecucion = resultados.find((r) => r.nombre === 'Bash' && r.entrada?.command === 'node x.mjs');
    expect(ejecucion, 'el script tenía que correr').toBeTruthy();
    expect(ejecucion!.contenido).toContain('VARIABLES');
    const salida = archivoEnRama(nucleo, a, 'prueba', 'salida.txt') ?? '';
    for (const secreto of [env.ANTHROPIC_AUTH_TOKEN!, env.CAMPUSIA_TOKEN_CURSO!, nucleo.tokenReal]) {
      expect(cuerpos).not.toContain(secreto);
      expect(salida).not.toContain(secreto);
    }
  });
});

