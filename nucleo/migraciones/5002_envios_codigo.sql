CREATE TABLE envios_codigo (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    media_seg REAL NOT NULL,
    fallo INTEGER NOT NULL,
    actualizado_en TEXT NOT NULL
);
