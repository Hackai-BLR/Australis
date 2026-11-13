import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export type Base = Database.Database;

interface Migracion {
  version: number;
  sql: string;
}

export const MIGRACIONES: Migracion[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE clases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        numero INTEGER NOT NULL,
        titulo TEXT NOT NULL,
        fecha TEXT,
        contenido TEXT NOT NULL DEFAULT '',
        creada TEXT NOT NULL
      );
      CREATE INDEX clases_numero ON clases(numero);
    `,
  },
];

export function migrar(base: Base, migraciones: Migracion[] = MIGRACIONES): number[] {
  base.exec('CREATE TABLE IF NOT EXISTS migraciones (version INTEGER PRIMARY KEY, aplicada TEXT NOT NULL)');
  const aplicar = base.transaction(() => {
    const hechas = new Set(
      (base.prepare('SELECT version FROM migraciones').all() as { version: number }[]).map((f) => f.version),
    );
    const nuevas: number[] = [];
    const registrar = base.prepare('INSERT INTO migraciones (version, aplicada) VALUES (?, ?)');
    for (const m of [...migraciones].sort((a, b) => a.version - b.version)) {
      if (hechas.has(m.version)) continue;
      base.exec(m.sql);
      registrar.run(m.version, new Date().toISOString());
      nuevas.push(m.version);
    }
    return nuevas;
  });
  return aplicar.immediate();
}

export function abrirBase(carpeta: string): Base {
  mkdirSync(carpeta, { recursive: true });
  const base = new Database(join(carpeta, 'curso.sqlite'));
  base.pragma('journal_mode = WAL');
  base.pragma('foreign_keys = ON');
  base.pragma('busy_timeout = 5000');
  migrar(base);
  return base;
}

export function abrirBaseEnMemoria(): Base {
  const base = new Database(':memory:');
  migrar(base);
  return base;
}
