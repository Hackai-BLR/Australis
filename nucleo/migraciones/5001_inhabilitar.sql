ALTER TABLE usuarios ADD COLUMN suspendida_en TEXT NULL;
ALTER TABLE usuarios ADD COLUMN suspendida_por INTEGER NULL REFERENCES usuarios(id);
ALTER TABLE usuarios ADD COLUMN baja_en TEXT NULL;
ALTER TABLE universidades ADD COLUMN deshabilitada_en TEXT NULL;
ALTER TABLE cursos ADD COLUMN archivado_en TEXT NULL;
ALTER TABLE cursos ADD COLUMN archivado_por INTEGER NULL REFERENCES usuarios(id);

CREATE TABLE inscripciones_historia (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL,
    usuario_id INTEGER NOT NULL,
    rol TEXT NOT NULL,
    creada_en TEXT NOT NULL,
    quitada_en TEXT NOT NULL,
    motivo TEXT NOT NULL CHECK (motivo IN ('baja', 'desinscripcion')),
    actor_id INTEGER NULL
);

CREATE INDEX inscripciones_historia_usuario ON inscripciones_historia(usuario_id);
CREATE INDEX inscripciones_historia_curso ON inscripciones_historia(curso_id);

CREATE TRIGGER inscripciones_historia_sin_cambios BEFORE UPDATE ON inscripciones_historia
BEGIN
    SELECT RAISE(ABORT, 'inscripciones_historia de solo agregado');
END;

CREATE TRIGGER inscripciones_historia_sin_borrado BEFORE DELETE ON inscripciones_historia
BEGIN
    SELECT RAISE(ABORT, 'inscripciones_historia de solo agregado');
END;
