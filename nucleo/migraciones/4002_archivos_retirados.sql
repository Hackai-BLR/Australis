CREATE TABLE archivos_retirados (
    archivo_id TEXT PRIMARY KEY REFERENCES archivos(id),
    motivo TEXT NOT NULL,
    retirado_en TEXT NOT NULL
);

CREATE TRIGGER archivos_retirados_sin_cambios BEFORE UPDATE ON archivos_retirados
BEGIN
    SELECT RAISE(ABORT, 'archivos retirados de solo agregado');
END;

CREATE TRIGGER archivos_retirados_sin_borrado BEFORE DELETE ON archivos_retirados
BEGIN
    SELECT RAISE(ABORT, 'archivos retirados de solo agregado');
END;
