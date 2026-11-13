ALTER TABLE cursos ADD COLUMN estado TEXT NOT NULL DEFAULT 'sin_repo'
    CHECK (estado IN ('sin_repo', 'preparando', 'listo', 'error'));

CREATE TABLE contenedores (
    curso_id TEXT PRIMARY KEY REFERENCES cursos(id),
    nombre TEXT NOT NULL,
    imagen TEXT NULL,
    commit_main TEXT NULL,
    token_huella TEXT NOT NULL UNIQUE,
    estado TEXT NOT NULL CHECK (estado IN ('apagado', 'encendiendo', 'encendido', 'error')),
    ultima_peticion TEXT NULL,
    error TEXT NULL,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
);

CREATE TABLE codigos_curso (
    curso_id TEXT PRIMARY KEY REFERENCES cursos(id),
    codigo TEXT NOT NULL UNIQUE,
    activo INTEGER NOT NULL DEFAULT 0,
    vence_en TEXT NULL,
    creado_en TEXT NOT NULL,
    creado_por INTEGER NULL
);
