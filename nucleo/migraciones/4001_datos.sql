CREATE TABLE archivos (
    id TEXT PRIMARY KEY CHECK (length(id) = 32),
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    nombre TEXT NOT NULL,
    extension TEXT NOT NULL,
    tamano INTEGER NOT NULL CHECK (tamano >= 0),
    sha256 TEXT NOT NULL,
    material INTEGER NOT NULL DEFAULT 0 CHECK (material IN (0, 1)),
    via TEXT NOT NULL CHECK (via IN ('plataforma', 'curso')),
    creado_en TEXT NOT NULL
);

CREATE INDEX archivos_curso ON archivos(curso_id, id);

CREATE TABLE entregas (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    actividad TEXT NOT NULL,
    texto TEXT NULL,
    archivo_id TEXT NULL REFERENCES archivos(id),
    via TEXT NOT NULL CHECK (via IN ('plataforma', 'curso')),
    creada_en TEXT NOT NULL
);

CREATE INDEX entregas_curso ON entregas(curso_id, id);

CREATE TABLE notas (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    actividad TEXT NOT NULL,
    valor TEXT NOT NULL,
    comentario TEXT NULL,
    anterior TEXT NULL,
    autor_id INTEGER NOT NULL REFERENCES usuarios(id),
    via TEXT NOT NULL CHECK (via IN ('plataforma', 'curso')),
    creada_en TEXT NOT NULL
);

CREATE INDEX notas_curso ON notas(curso_id, id);
CREATE INDEX notas_vigente ON notas(curso_id, usuario_id, actividad);

CREATE TRIGGER archivos_sin_cambios BEFORE UPDATE ON archivos
BEGIN
    SELECT RAISE(ABORT, 'archivos de solo agregado');
END;

CREATE TRIGGER archivos_sin_borrado BEFORE DELETE ON archivos
BEGIN
    SELECT RAISE(ABORT, 'archivos de solo agregado');
END;

CREATE TRIGGER entregas_sin_cambios BEFORE UPDATE ON entregas
BEGIN
    SELECT RAISE(ABORT, 'entregas de solo agregado');
END;

CREATE TRIGGER entregas_sin_borrado BEFORE DELETE ON entregas
BEGIN
    SELECT RAISE(ABORT, 'entregas de solo agregado');
END;

CREATE TRIGGER notas_sin_cambios BEFORE UPDATE ON notas
BEGIN
    SELECT RAISE(ABORT, 'notas de solo agregado');
END;

CREATE TRIGGER notas_sin_borrado BEFORE DELETE ON notas
BEGIN
    SELECT RAISE(ABORT, 'notas de solo agregado');
END;
