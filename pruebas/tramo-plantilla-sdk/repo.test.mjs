import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../../', import.meta.url));

function archivos(dir, extensiones, fuera = ['node_modules', 'dist', 'vendor', '.git']) {
  const res = [];
  if (!existsSync(dir)) return res;
  for (const n of readdirSync(dir)) {
    if (fuera.includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) res.push(...archivos(p, extensiones, fuera));
    else if (extensiones.some((e) => n.endsWith(e))) res.push(p);
  }
  return res;
}

test('la plantilla trae CLAUDE.md con las reglas para el agente del curso', () => {
  const p = join(raiz, 'plantilla-curso', 'CLAUDE.md');
  assert.ok(existsSync(p), 'falta plantilla-curso/CLAUDE.md');
  const t = readFileSync(p, 'utf8').toLowerCase();
  for (const termino of ['/salud', '@campusia/sdk', 'campusia_datos', 'pnpm test', 'internet', 'contraseña', 'comentarios', 'castellano']) {
    assert.ok(t.includes(termino), `CLAUDE.md no menciona ${termino}`);
  }
});

test('la plantilla trae un Containerfile con usuario sin privilegios y HEALTHCHECK', () => {
  const p = join(raiz, 'plantilla-curso', 'Containerfile');
  assert.ok(existsSync(p), 'falta plantilla-curso/Containerfile');
  const t = readFileSync(p, 'utf8');
  assert.match(t, /^USER\s+\S+/m);
  assert.doesNotMatch(t, /^USER\s+(root|0)(:|\s|$)/m);
  assert.match(t, /^HEALTHCHECK\s/m);
  assert.ok((t.match(/^FROM\s/gm) || []).length >= 2, 'la imagen tiene que ser multi-etapa');
});

test('SDK y plantilla tienen pruebas propias', () => {
  for (const d of ['sdk', 'plantilla-curso']) {
    const pkg = JSON.parse(readFileSync(join(raiz, d, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts?.test, `${d} no define el script test`);
    assert.ok(pkg.scripts?.build, `${d} no define el script build`);
    assert.ok(archivos(join(raiz, d), ['.test.ts', '.test.tsx', '.test.mjs', '.test.js']).length > 0, `${d} no tiene archivos de prueba`);
  }
});

test('el código del SDK y de la plantilla no lleva comentarios', () => {
  const fuentes = [
    ...archivos(join(raiz, 'sdk'), ['.ts', '.tsx', '.mjs', '.js']),
    ...archivos(join(raiz, 'plantilla-curso'), ['.ts', '.tsx', '.mjs', '.js', '.css']),
  ];
  assert.ok(fuentes.length > 0, 'no hay código fuente');
  const con = [];
  for (const f of fuentes) {
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      const s = l.trim();
      if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*/') || /\s\/\/\s/.test(l) || /\/\*.*\*\//.test(l)) con.push(`${f.slice(raiz.length)}:${i + 1}`);
    });
  }
  assert.deepEqual(con, []);
});

test('el tramo no toca carpetas de otros tramos', () => {
  const permitidas = ['sdk', 'plantilla-curso', 'contratos', 'pruebas', 'handoffs', 'prototipo', 'nucleo', 'interfaz', 'despliegue', 'infraestructura', 'CONVENCIONES.md', 'README.md', '.git', '.gitignore', 'node_modules', '.claude', '.orquestacion'];
  for (const n of readdirSync(raiz)) assert.ok(permitidas.includes(n), `carpeta inesperada en la raíz: ${n}`);
});
