import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANDOFFS = path.join(RAIZ, 'handoffs');

function delTramo() {
  return fs
    .readdirSync(HANDOFFS)
    .filter((f) => /^\d{6}_\d{4}_.+\.md$/.test(f))
    .filter((f) => /acciones-y-cupos/.test(f))
    .sort();
}

test('el tramo deja un handoff con el nombre de la convención', () => {
  assert.ok(delTramo().length > 0, 'no hay un handoff AAMMDD_HHMM_*acciones-y-cupos*.md en handoffs/');
});

test('el handoff es posterior a los anteriores y dice cómo compilar, levantar y probar', () => {
  const todos = fs.readdirSync(HANDOFFS).filter((f) => /^\d{6}_\d{4}_.+\.md$/.test(f)).sort();
  const propio = delTramo().pop();
  assert.ok(propio);
  const anteriores = todos.filter((f) => !/acciones-y-cupos/.test(f));
  assert.ok(propio > anteriores[anteriores.length - 1], `${propio} tiene que ir después de ${anteriores[anteriores.length - 1]}`);
  const texto = fs.readFileSync(path.join(HANDOFFS, propio), 'utf8');
  assert.match(texto, /cargo build/);
  assert.match(texto, /construir-espacio\.sh/);
  assert.match(texto, /campusia-nucleo migrar/);
  assert.match(texto, /campusia-nucleo sembrar/);
  assert.match(texto, /pruebas\/tramo-acciones-y-cupos\/correr\.sh/);
  assert.match(texto, /contratos\/tramo-acciones-y-cupos\.md/);
});

test('el handoff avisa las pruebas que se corrigieron porque no coincidían con el contrato', () => {
  const texto = fs.readFileSync(path.join(HANDOFFS, delTramo().pop()), 'utf8');
  assert.match(texto, /tramo-inhabilitar\/aceptacion\/roles\.spec\.ts/);
  assert.match(texto, /tramo-inhabilitar\/ataque\/roles\.spec\.ts/);
});
