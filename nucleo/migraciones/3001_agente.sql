CREATE TABLE espacios (
    curso_id TEXT PRIMARY KEY REFERENCES cursos(id),
    nombre TEXT NOT NULL,
    estado TEXT NOT NULL CHECK (estado IN ('apagado', 'encendiendo', 'encendido', 'error')),
    token_modelo_huella TEXT NOT NULL UNIQUE,
    token_curso_huella TEXT NOT NULL UNIQUE,
    ultima_actividad TEXT NULL,
    error TEXT NULL,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
);

CREATE TABLE mensajes_agente (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    rol TEXT NOT NULL CHECK (rol IN ('profesor', 'agente')),
    autor_id INTEGER NULL REFERENCES usuarios(id),
    texto TEXT NOT NULL,
    archivos TEXT NOT NULL DEFAULT '[]',
    estado TEXT NOT NULL CHECK (estado IN ('en_curso', 'ok', 'error')),
    commit_prueba TEXT NULL,
    creado_en TEXT NOT NULL,
    terminado_en TEXT NULL
);

CREATE INDEX mensajes_agente_curso ON mensajes_agente(curso_id, id);

CREATE TABLE uso_modelo (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL,
    universidad_id INTEGER NOT NULL,
    mes TEXT NOT NULL,
    fecha TEXT NOT NULL,
    ruta TEXT NOT NULL,
    estado INTEGER NOT NULL,
    modelo TEXT NULL,
    tokens_entrada INTEGER NOT NULL,
    tokens_salida INTEGER NOT NULL,
    tokens_cache_creacion INTEGER NOT NULL,
    tokens_cache_lectura INTEGER NOT NULL,
    usd REAL NOT NULL
);

CREATE INDEX uso_modelo_curso ON uso_modelo(curso_id, mes);

CREATE TABLE publicaciones (
    id INTEGER PRIMARY KEY,
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('publicar', 'volver')),
    estado TEXT NOT NULL CHECK (estado IN ('en_curso', 'ok', 'error')),
    etapa TEXT NOT NULL,
    version INTEGER NULL,
    desde_version INTEGER NULL,
    commit_candidato TEXT NULL,
    descripcion TEXT NOT NULL,
    error TEXT NULL,
    registro TEXT NOT NULL DEFAULT '',
    autor_id INTEGER NULL,
    creada_en TEXT NOT NULL,
    terminada_en TEXT NULL
);

CREATE INDEX publicaciones_curso ON publicaciones(curso_id, id);

CREATE TABLE versiones (
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    numero INTEGER NOT NULL,
    commit_main TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    autor_id INTEGER NULL,
    origen INTEGER NULL,
    imagen TEXT NULL,
    fecha TEXT NOT NULL,
    PRIMARY KEY (curso_id, numero)
);
