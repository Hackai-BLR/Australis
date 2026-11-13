ALTER TABLE universidades ADD COLUMN cupo_tokens INTEGER NOT NULL DEFAULT 20000000;
UPDATE universidades SET cupo_tokens = CAST(ROUND(limite_usd * 1000000) AS INTEGER);
ALTER TABLE universidades ADD COLUMN cupo_profesor_predeterminado INTEGER NULL;

CREATE TABLE cupos_profesor (
    usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
    universidad_id INTEGER NOT NULL REFERENCES universidades(id),
    tokens INTEGER NOT NULL,
    actualizado_en TEXT NOT NULL,
    actualizado_por INTEGER NULL
);

CREATE INDEX cupos_profesor_universidad ON cupos_profesor(universidad_id);

ALTER TABLE uso_modelo ADD COLUMN usuario_id INTEGER NULL;
ALTER TABLE uso_modelo ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;

UPDATE uso_modelo SET tokens = tokens_entrada + tokens_cache_creacion + tokens_cache_lectura + tokens_salida;

CREATE INDEX uso_modelo_universidad ON uso_modelo(universidad_id, mes);
CREATE INDEX uso_modelo_usuario ON uso_modelo(usuario_id, mes);

CREATE TABLE tokens_agente (
    id INTEGER PRIMARY KEY,
    huella TEXT NOT NULL UNIQUE,
    curso_id TEXT NOT NULL,
    usuario_id INTEGER NOT NULL,
    mensaje_id INTEGER NULL,
    creado_en TEXT NOT NULL,
    vence_en TEXT NOT NULL,
    revocado INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX tokens_agente_curso ON tokens_agente(curso_id);

CREATE TABLE confirmaciones_agente (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('quitar', 'rol')),
    usuario_id INTEGER NOT NULL,
    rol TEXT NULL CHECK (rol IN ('alumno', 'profesor')),
    pedida_por INTEGER NOT NULL,
    mensaje_id INTEGER NULL,
    estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'fallida')),
    error TEXT NULL,
    creada_en TEXT NOT NULL,
    resuelta_en TEXT NULL,
    resuelta_por INTEGER NULL
);

CREATE INDEX confirmaciones_agente_curso ON confirmaciones_agente(curso_id, estado, id);

ALTER TABLE auditoria ADD COLUMN agente INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sesiones ADD COLUMN ultimo_uso TEXT NULL;
UPDATE sesiones SET ultimo_uso = creada_en;
