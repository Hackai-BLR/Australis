CREATE TABLE campus_modulos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campus_externo INTEGER NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    universidad_id INTEGER NOT NULL REFERENCES universidades(id),
    creado_por INTEGER NOT NULL REFERENCES usuarios(id),
    creado_en TEXT NOT NULL
);

CREATE INDEX campus_modulos_universidad ON campus_modulos(universidad_id);

CREATE TABLE inscripciones_modulos (
    campus_id INTEGER NOT NULL REFERENCES campus_modulos(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    rol TEXT NOT NULL CHECK (rol IN ('dueño', 'profesor', 'alumno')),
    suspendida INTEGER NOT NULL DEFAULT 0,
    creada_en TEXT NOT NULL,
    PRIMARY KEY (campus_id, usuario_id)
);

CREATE INDEX inscripciones_modulos_usuario ON inscripciones_modulos(usuario_id);
