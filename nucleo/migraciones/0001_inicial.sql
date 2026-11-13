CREATE TABLE universidades (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    limite_usd REAL NOT NULL DEFAULT 20,
    creada_en TEXT NOT NULL
);

CREATE TABLE dominios (
    dominio TEXT PRIMARY KEY,
    universidad_id INTEGER NOT NULL REFERENCES universidades(id)
);

CREATE INDEX dominios_universidad ON dominios(universidad_id);

CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    universidad_id INTEGER NULL REFERENCES universidades(id),
    profesor INTEGER NOT NULL DEFAULT 0,
    administrador INTEGER NOT NULL DEFAULT 0,
    owner INTEGER NOT NULL DEFAULT 0,
    pendiente INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL,
    ultimo_ingreso TEXT NULL
);

CREATE INDEX usuarios_universidad ON usuarios(universidad_id);

CREATE TABLE sesiones (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    huella TEXT NOT NULL UNIQUE,
    creada_en TEXT NOT NULL,
    vence_en TEXT NOT NULL,
    revocada INTEGER NOT NULL DEFAULT 0,
    reautenticada_en TEXT NULL,
    ip TEXT,
    agente TEXT
);

CREATE INDEX sesiones_usuario ON sesiones(usuario_id);

CREATE TABLE codigos_login (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    proposito TEXT NOT NULL CHECK (proposito IN ('login', 'reautenticacion')),
    sesion_id INTEGER NULL,
    huella TEXT NOT NULL,
    intentos INTEGER NOT NULL DEFAULT 0,
    vence_en TEXT NOT NULL,
    usado INTEGER NOT NULL DEFAULT 0,
    anulado INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL,
    ip TEXT,
    solicitud TEXT NULL
);

CREATE INDEX codigos_login_email ON codigos_login(email, proposito);

CREATE TABLE tokens_api (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    nombre TEXT NOT NULL,
    huella TEXT NOT NULL UNIQUE,
    permisos TEXT NOT NULL,
    creado_en TEXT NOT NULL,
    vence_en TEXT NOT NULL,
    revocado INTEGER NOT NULL DEFAULT 0,
    ultimo_uso TEXT NULL
);

CREATE INDEX tokens_api_usuario ON tokens_api(usuario_id);

CREATE TABLE cursos (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    periodo TEXT NOT NULL,
    color TEXT NOT NULL,
    universidad_id INTEGER NOT NULL REFERENCES universidades(id),
    version_publicada INTEGER NULL,
    creado_en TEXT NOT NULL
);

CREATE INDEX cursos_universidad ON cursos(universidad_id);

CREATE TABLE inscripciones (
    curso_id TEXT NOT NULL REFERENCES cursos(id),
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    rol TEXT NOT NULL CHECK (rol IN ('dueño', 'profesor', 'alumno')),
    creada_en TEXT NOT NULL,
    PRIMARY KEY (curso_id, usuario_id)
);

CREATE INDEX inscripciones_usuario ON inscripciones(usuario_id);

CREATE TABLE uso_agente (
    curso_id TEXT NOT NULL,
    mes TEXT NOT NULL,
    usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (curso_id, mes)
);

CREATE TABLE auditoria (
    id INTEGER PRIMARY KEY,
    fecha TEXT NOT NULL,
    universidad_id INTEGER NULL,
    actor_id INTEGER NULL,
    accion TEXT NOT NULL,
    detalle TEXT NOT NULL,
    ip TEXT NULL
);

CREATE INDEX auditoria_universidad ON auditoria(universidad_id, id);

CREATE TRIGGER auditoria_sin_cambios BEFORE UPDATE ON auditoria
BEGIN
    SELECT RAISE(ABORT, 'auditoria de solo agregado');
END;

CREATE TRIGGER auditoria_sin_borrado BEFORE DELETE ON auditoria
BEGIN
    SELECT RAISE(ABORT, 'auditoria de solo agregado');
END;

CREATE TABLE configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

INSERT INTO configuracion (clave, valor) VALUES ('proveedor_modelo', 'api'), ('proveedor_email', 'brevo');

CREATE TABLE limites (
    id INTEGER PRIMARY KEY,
    tipo TEXT NOT NULL,
    clave TEXT NOT NULL,
    fecha TEXT NOT NULL
);

CREATE INDEX limites_tipo_clave ON limites(tipo, clave, fecha);

CREATE TABLE emails_enviados (
    id INTEGER PRIMARY KEY,
    tipo TEXT NOT NULL,
    fecha TEXT NOT NULL
);

CREATE INDEX emails_enviados_fecha ON emails_enviados(fecha);
