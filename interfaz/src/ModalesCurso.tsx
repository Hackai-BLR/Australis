import { useMemo, useState } from 'react';
import { ErrorApi, esCancelado, post, type CursoPropio } from './api';
import { Modal } from './comun';

export function slug(texto: string) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function periodosDisponibles(hoy = new Date()) {
  const a = hoy.getFullYear();
  if (hoy.getMonth() < 6) return [`1.er cuatrimestre ${a}`, `2.º cuatrimestre ${a}`, `Anual ${a}`, `1.er cuatrimestre ${a + 1}`];
  return [`2.º cuatrimestre ${a}`, `1.er cuatrimestre ${a + 1}`, `2.º cuatrimestre ${a + 1}`, `Anual ${a + 1}`];
}

const ERRORES_CREAR: Record<string, string> = {
  subdominio_en_uso: 'Esa dirección ya está en uso.',
  subdominio_invalido: 'Esa dirección no se puede usar.',
  datos_invalidos: 'Revisá el nombre y el período.',
  prohibido: 'No podés crear cursos.',
  servicio_no_disponible: 'Por ahora no se pueden crear cursos. Probá más tarde.',
};

export function ModalCrear({
  dominioBase,
  urlCurso,
  alCerrar,
}: {
  dominioBase: string;
  urlCurso: (id: string) => string;
  alCerrar: () => void;
}) {
  const periodos = useMemo(() => periodosDisponibles(), []);
  const [nombre, setNombre] = useState('');
  const [sub, setSub] = useState('');
  const [tocado, setTocado] = useState(false);
  const [periodo, setPeriodo] = useState(periodos[0]);
  const [tipo, setTipo] = useState<'libre' | 'modulos'>('libre');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const crear = async () => {
    if (ocupado) return;
    const n = nombre.trim();
    const s = (sub.trim() || slug(n)).toLowerCase();
    if (!n) {
      setError('Ponele un nombre.');
      return;
    }
    if (tipo === 'libre' && !s) {
      setError('Elegí una dirección.');
      return;
    }
    setError('');
    setOcupado(true);
    try {
      if (tipo === 'modulos') {
        const m = await post<CursoPropio>('/api/cursos-modulos', { nombre: n });
        window.location.href = `${urlCurso('campus').replace(/\/$/, '')}/campuses/${m.campus_externo}`;
        return;
      }
      const c = await post<CursoPropio>('/api/cursos', { nombre: n, subdominio: s, periodo });
      window.location.href = urlCurso(c.id);
    } catch (e) {
      setOcupado(false);
      if (esCancelado(e)) return;
      if (e instanceof ErrorApi) setError(ERRORES_CREAR[e.codigo] ?? e.mensaje);
      else setError('No se pudo crear el curso.');
    }
  };

  const alTeclear = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void crear();
  };

  return (
    <Modal alCerrar={alCerrar} id="modal">
      <h3>Crear curso</h3>
      <p className="desc">
        {tipo === 'libre'
          ? 'Después lo armás con el agente. Nadie lo ve hasta que lo publiques.'
          : 'Con libro de calificaciones, clases, grabaciones y presentaciones.'}
      </p>
      <div className="etq">Tipo</div>
      <select className="campo" id="c-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as 'libre' | 'modulos')}>
        <option value="libre">Curso libre</option>
        <option value="modulos">Campus con módulos</option>
      </select>
      <label className="etq" htmlFor="c-nombre">
        Nombre
      </label>
      <input
        className="campo"
        id="c-nombre"
        placeholder="Sistemas Operativos"
        maxLength={120}
        value={nombre}
        onChange={(e) => {
          setNombre(e.target.value);
          if (!tocado) setSub(slug(e.target.value));
        }}
        onKeyDown={alTeclear}
      />
      {tipo === 'libre' && (
        <>
      <label className="etq" htmlFor="c-sub">
        Dirección
      </label>
      <div className="sufijo">
        <input
          id="c-sub"
          placeholder="sistemas-operativos"
          maxLength={40}
          autoCapitalize="off"
          spellCheck={false}
          value={sub}
          onChange={(e) => {
            setTocado(true);
            setSub(e.target.value);
          }}
          onKeyDown={alTeclear}
        />
        <span>.{dominioBase}</span>
      </div>
      <label className="etq" htmlFor="c-per">
        Período
      </label>
      <select className="campo" id="c-per" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
        {periodos.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
        </>
      )}
      <div className="err" id="c-err">
        {error}
      </div>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className="btn prim" data-accion="crear-ok" onClick={() => void crear()} disabled={ocupado}>
          Crear
        </button>
      </div>
    </Modal>
  );
}

export function ModalUnirse({ urlCurso, alCerrar }: { urlCurso: (id: string) => string; alCerrar: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const unirse = async () => {
    if (ocupado) return;
    const c = codigo.trim().toUpperCase();
    if (!c) {
      setError('Escribí el código.');
      return;
    }
    setError('');
    setOcupado(true);
    try {
      const r = await post<{ curso: { id: string } }>('/api/unirse', { codigo: c });
      window.location.href = urlCurso(r.curso.id);
    } catch (e) {
      setOcupado(false);
      if (esCancelado(e)) return;
      if (e instanceof ErrorApi && e.status === 429) setError('Hiciste demasiados intentos. Esperá unos minutos y probá de nuevo.');
      else if (e instanceof ErrorApi && (e.codigo === 'codigo_invalido' || e.codigo === 'datos_invalidos' || e.status === 404))
        setError('Ese código no existe o ya no está activo.');
      else if (e instanceof ErrorApi) setError(e.mensaje);
      else setError('No se pudo completar. Probá de nuevo.');
    }
  };

  return (
    <Modal alCerrar={alCerrar} id="modal">
      <h3>Unirme a un curso</h3>
      <p className="desc">Escribí el código que te pasó tu profesor.</p>
      <input
        className="campo"
        id="u-cod"
        placeholder="RED-4K7P9X"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}
        value={codigo}
        onChange={(e) => setCodigo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void unirse();
        }}
      />
      <div className="err" id="u-err">
        {error}
      </div>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className="btn prim" data-accion="unirse-ok" onClick={() => void unirse()} disabled={ocupado}>
          Unirme
        </button>
      </div>
    </Modal>
  );
}
