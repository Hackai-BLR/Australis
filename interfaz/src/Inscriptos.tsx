import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ErrorApi,
  borrar,
  esCancelado,
  get,
  post,
  put,
  type CodigoCurso,
  type CursoPropio,
  type Inscripto,
  type ListaInscriptos,
  type RolCurso,
  type Usuario,
} from './api';
import { Avatar, avisar, avisarError } from './comun';

type Formulario = 'f-mails' | 'f-siu' | 'f-codigo';

type Confirmacion = { tipo: 'quitar' | 'transferir'; id: number } | null;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fechaLarga(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const anio = d.getFullYear() !== new Date().getFullYear() ? ` de ${d.getFullYear()}` : '';
  return `${d.getDate()} de ${MESES[d.getMonth()]}${anio}`;
}

function textoVence(c: CodigoCurso) {
  if (!c.activo) return 'Desactivado';
  if (!c.vence) return 'Sin vencimiento';
  if (Date.parse(c.vence) <= Date.now()) return `Venció el ${fechaLarga(c.vence)}`;
  return `Vence el ${fechaLarga(c.vence)}`;
}

function plural(n: number, uno: string, varios: string) {
  return `${n} ${n === 1 ? uno : varios}`;
}

function nombreRol(r: RolCurso) {
  return r === 'dueño' ? 'Dueño' : r === 'profesor' ? 'Profesor' : 'Alumno';
}

function leerBase64(archivo: File) {
  return new Promise<string>((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onload = () => {
      const r = String(lector.result ?? '');
      const i = r.indexOf(',');
      resolver(i >= 0 ? r.slice(i + 1) : r);
    };
    lector.onerror = () => rechazar(lector.error);
    lector.readAsDataURL(archivo);
  });
}

const MOTIVOS: Record<string, string> = {
  email_invalido: 'mail inválido',
  dominio_no_habilitado: 'no es de la universidad',
};

export function PanelInscriptos({
  curso,
  usuario,
  alCerrar,
  alCambiarCurso,
}: {
  curso: CursoPropio;
  usuario: Usuario;
  alCerrar: () => void;
  alCambiarCurso: () => void;
}) {
  const base = `/api/cursos/${encodeURIComponent(curso.id)}`;
  const dueno = curso.rol === 'dueño';
  const [lista, setLista] = useState<ListaInscriptos | null>(null);
  const [codigo, setCodigo] = useState<CodigoCurso | null>(null);
  const [form, setForm] = useState<Formulario | null>(null);
  const [mails, setMails] = useState('');
  const [rolNuevo, setRolNuevo] = useState<'alumno' | 'profesor'>('alumno');
  const [errMails, setErrMails] = useState('');
  const [errSiu, setErrSiu] = useState('');
  const [confirmar, setConfirmar] = useState<Confirmacion>(null);
  const [ocupado, setOcupado] = useState(false);
  const [importando, setImportando] = useState(false);
  const archivo = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const cargar = useCallback(async () => {
    try {
      setLista(await get<ListaInscriptos>(`${base}/inscriptos`));
    } catch (e) {
      avisarError(e);
    }
  }, [base]);

  const cargarCodigo = useCallback(async () => {
    try {
      setCodigo(await get<CodigoCurso>(`${base}/codigo`));
    } catch (e) {
      avisarError(e);
    }
  }, [base]);

  useEffect(() => {
    void cargar();
    void cargarCodigo();
  }, [cargar, cargarCodigo]);

  useEffect(() => {
    if (!dueno && rolNuevo === 'profesor') setRolNuevo('alumno');
  }, [dueno, rolNuevo]);

  useEffect(() => {
    if (form === 'f-mails') textarea.current?.focus();
  }, [form]);

  const alternarForm = (f: Formulario) => {
    setForm((a) => (a === f ? null : f));
    if (f === 'f-codigo') void cargarCodigo();
  };

  const agregar = async () => {
    if (ocupado) return;
    const lista = [...new Set(mails.split(/[\s,;]+/).map((m) => m.trim().toLowerCase()).filter(Boolean))];
    if (!lista.length) {
      setErrMails('Escribí al menos un mail.');
      return;
    }
    setErrMails('');
    setOcupado(true);
    try {
      const r = await post<{ agregados: string[]; ya_estaban: string[]; creados: string[] }>(`${base}/inscriptos`, { emails: lista, rol: rolNuevo });
      setMails('');
      setForm(null);
      const n = r.agregados.length;
      const ya = r.ya_estaban.length;
      avisar(
        n
          ? `${plural(n, 'persona agregada', 'personas agregadas')}${ya ? ` · ${plural(ya, 'ya estaba', 'ya estaban')}` : ''}`
          : ya === 1
            ? 'Ya estaba inscripta'
            : 'Ya estaban todos inscriptos',
      );
      await cargar();
    } catch (e) {
      if (esCancelado(e)) return;
      if (e instanceof ErrorApi) {
        const emails: string[] = Array.isArray(e.datos?.emails) ? e.datos.emails : [];
        const lista = emails.join(', ');
        if (e.codigo === 'dominio_no_habilitado') setErrMails(lista ? `No son de la universidad: ${lista}` : 'Hay mails que no son de la universidad.');
        else if (e.codigo === 'email_invalido') setErrMails(lista ? `No son mails válidos: ${lista}` : 'Hay mails que no son válidos.');
        else if (e.codigo === 'no_es_profesor')
          setErrMails(lista ? `No están marcados como profesores: ${lista}` : 'Hay personas que no están marcadas como profesores.');
        else if (e.codigo === 'datos_invalidos') setErrMails('Revisá la lista: hasta 500 mails por vez.');
        else setErrMails(e.mensaje);
      } else setErrMails('No se pudo agregar. Probá de nuevo.');
    } finally {
      setOcupado(false);
    }
  };

  const importar = async (f: File) => {
    setErrSiu('');
    if (f.size > 2 * 1024 * 1024) {
      setErrSiu('El archivo es muy grande. El máximo es 2 MB.');
      return;
    }
    setImportando(true);
    try {
      const contenido = await leerBase64(f);
      const r = await post<{ agregados: string[]; ya_estaban: string[]; creados: string[]; rechazados: { fila: number; email: string; motivo: string }[] }>(
        `${base}/inscriptos/siu`,
        { archivo: f.name, contenido },
      );
      const n = r.agregados.length;
      const rech = r.rechazados ?? [];
      let texto = `${n} alumnos importados del SIU`;
      if (rech.length) texto += ` · ${plural(rech.length, 'rechazado', 'rechazados')}`;
      avisar(texto, rech.length ? 5000 : 3000);
      if (rech.length) {
        setErrSiu(
          'No se importaron: ' +
            rech
              .slice(0, 20)
              .map((x) => `${x.email || 'sin mail'} (fila ${x.fila}, ${MOTIVOS[x.motivo] ?? x.motivo})`)
              .join(', ') +
            (rech.length > 20 ? ` y ${rech.length - 20} más` : ''),
        );
      } else setForm(null);
      await cargar();
    } catch (e) {
      if (esCancelado(e)) return;
      if (e instanceof ErrorApi && (e.codigo === 'archivo_invalido' || e.status === 413))
        setErrSiu(e.status === 413 ? 'El archivo es muy grande. El máximo es 2 MB.' : 'No se pudo leer el archivo. Tiene que ser un CSV o Excel con una columna de mail.');
      else if (e instanceof ErrorApi) setErrSiu(e.mensaje);
      else setErrSiu('No se pudo leer el archivo.');
    } finally {
      setImportando(false);
      if (archivo.current) archivo.current.value = '';
    }
  };

  const generarCodigo = async () => {
    if (ocupado) return;
    setOcupado(true);
    try {
      const nuevo = await post<CodigoCurso>(`${base}/codigo`, {});
      setCodigo(nuevo);
      avisar('El código anterior dejó de funcionar');
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };

  const alternarCodigo = async () => {
    if (!codigo || ocupado) return;
    setOcupado(true);
    try {
      setCodigo(await put<CodigoCurso>(`${base}/codigo`, { activo: !codigo.activo }));
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };

  const cambiarRol = async (p: Inscripto, rol: 'alumno' | 'profesor') => {
    if (rol === p.rol) return;
    setLista((l) => (l ? { ...l, inscriptos: l.inscriptos.map((x) => (x.id === p.id ? { ...x, rol } : x)) } : l));
    try {
      await put(`${base}/inscriptos/${p.id}`, { rol });
      avisar(`${p.nombre.split(' ')[0]} ahora es ${rol}`);
    } catch (e) {
      if (!esCancelado(e)) {
        if (e instanceof ErrorApi && e.codigo === 'no_es_profesor') avisar(`${p.nombre} no está marcado como profesor`);
        else avisarError(e);
      }
    }
    await cargar();
  };

  const quitar = async (p: Inscripto) => {
    try {
      await borrar(`${base}/inscriptos/${p.id}`);
      avisar(`${p.nombre} ya no está en el curso`);
    } catch (e) {
      if (!esCancelado(e)) {
        if (e instanceof ErrorApi && e.codigo === 'es_dueno') avisar('Al dueño no se lo puede quitar');
        else avisarError(e);
      }
    }
    setConfirmar(null);
    await cargar();
  };

  const transferir = async (p: Inscripto) => {
    try {
      await post(`${base}/transferir`, { usuario_id: p.id });
      avisar(`${p.nombre} ahora es dueño del curso`);
      alCambiarCurso();
    } catch (e) {
      if (!esCancelado(e)) {
        if (e instanceof ErrorApi && e.codigo === 'no_es_profesor') avisar(`${p.nombre} no está marcado como profesor`);
        else avisarError(e);
      }
    }
    setConfirmar(null);
    await cargar();
  };

  const titulo = lista ? `Inscriptos · ${plural(lista.alumnos, 'alumno', 'alumnos')}, ${plural(lista.profesores, 'profesor', 'profesores')}` : 'Inscriptos';

  return (
    <aside className="panel abierto" id="p-inscriptos">
      <div className="ph">
        <span id="ins-tit">{titulo}</span>
        <button data-cerrar aria-label="Cerrar" onClick={alCerrar}>
          &#x2715;
        </button>
      </div>
      <div className="ins-acc">
        <button className={`btn sec chico${form === 'f-mails' ? ' on' : ''}`} data-insf="f-mails" onClick={() => alternarForm('f-mails')}>
          Agregar
        </button>
        <button className={`btn sec chico${form === 'f-siu' ? ' on' : ''}`} data-insf="f-siu" onClick={() => alternarForm('f-siu')}>
          Importar del SIU
        </button>
        <button className={`btn sec chico${form === 'f-codigo' ? ' on' : ''}`} data-insf="f-codigo" onClick={() => alternarForm('f-codigo')}>
          Código
        </button>
      </div>
      <div className={`ins-form${form === 'f-mails' ? ' abierto' : ''}`} id="f-mails">
        <label className="etq" htmlFor="ins-mails">
          Mails, uno por línea o separados por coma
        </label>
        <textarea
          className="campo"
          id="ins-mails"
          ref={textarea}
          rows={3}
          placeholder="ana.perez@austral.edu.ar"
          value={mails}
          onChange={(e) => setMails(e.target.value)}
        />
        <div className="fila" style={{ marginTop: 10 }}>
          <select
            className="campo"
            id="ins-rol"
            style={{ height: 34, width: 'auto' }}
            value={rolNuevo}
            onChange={(e) => setRolNuevo(e.target.value as 'alumno' | 'profesor')}
          >
            <option value="alumno">Como alumnos</option>
            <option value="profesor" disabled={!dueno}>
              Como profesores
            </option>
          </select>
          <span className="esp"></span>
          <button className="btn prim chico" id="ins-agregar" onClick={() => void agregar()} disabled={ocupado}>
            Agregar
          </button>
        </div>
        <div className="err" id="ins-err">
          {errMails}
        </div>
      </div>
      <div className={`ins-form${form === 'f-siu' ? ' abierto' : ''}`} id="f-siu">
        <label className="etq" htmlFor="ins-archivo">
          Listado de inscriptos exportado del SIU (CSV o Excel)
        </label>
        <label className="btn sec chico archivo">
          {importando ? 'Importando…' : 'Elegir archivo'}
          <input
            type="file"
            id="ins-archivo"
            ref={archivo}
            accept=".csv,.xlsx,.xls"
            hidden
            disabled={importando}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void importar(f);
            }}
          />
        </label>
        <div className="err" id="siu-err">
          {errSiu}
        </div>
      </div>
      <div className={`ins-form${form === 'f-codigo' ? ' abierto' : ''}`} id="f-codigo">
        <label className="etq">Quien tenga el código entra como alumno</label>
        <div className="codigo">
          <div style={{ flex: 1 }}>
            <b id="cod-valor">{codigo?.codigo ?? ''}</b>
            <small id="cod-vence">{codigo ? textoVence(codigo) : ''}</small>
          </div>
          <button className="btn sec chico" id="cod-nuevo" onClick={() => void generarCodigo()} disabled={ocupado}>
            Generar otro
          </button>
        </div>
        <div className="fila" style={{ marginTop: 10 }}>
          <button
            className={`sw${codigo?.activo ? ' on' : ''}`}
            id="cod-sw"
            role="switch"
            aria-checked={!!codigo?.activo}
            aria-label="Código activo"
            disabled={!codigo}
            onClick={() => void alternarCodigo()}
          ></button>
          <span style={{ fontSize: 13 }}>Código activo</span>
        </div>
      </div>
      <div className="pcuerpo" id="ins-lista">
        {lista?.inscriptos.map((p) => {
          const soy = p.id === usuario.id;
          if (confirmar && confirmar.id === p.id) {
            const esQuitar = confirmar.tipo === 'quitar';
            return (
              <div className="persona conf" key={p.id} data-usuario={p.id}>
                <Avatar nombre={p.nombre} clave={p.email} />
                <div className="nm">
                  <b>{esQuitar ? `¿Quitar a ${p.nombre}?` : `¿Hacer dueño a ${p.nombre}?`}</b>
                  <small>{esQuitar ? 'Deja de ver el curso' : 'Vos pasás a ser profesor'}</small>
                </div>
                <button className="btn sec chico" data-noquitar={esQuitar ? '' : undefined} data-notransferir={esQuitar ? undefined : ''} onClick={() => setConfirmar(null)}>
                  No
                </button>
                {esQuitar ? (
                  <button className="btn chico peligro" data-siquitar={p.id} onClick={() => void quitar(p)}>
                    Quitar
                  </button>
                ) : (
                  <button className="btn prim chico" data-sitransferir={p.id} onClick={() => void transferir(p)}>
                    Hacer dueño
                  </button>
                )}
              </div>
            );
          }
          let control: React.ReactNode;
          if (p.rol === 'dueño') control = <span className="pill azul">Dueño</span>;
          else if (dueno && !soy)
            control = (
              <select data-rol={p.id} value={p.rol} onChange={(e) => void cambiarRol(p, e.target.value as 'alumno' | 'profesor')}>
                <option value="alumno">Alumno</option>
                <option value="profesor" disabled={p.profesor === false && p.rol !== 'profesor'}>
                  Profesor
                </option>
              </select>
            );
          else control = <span className="pill">{nombreRol(p.rol)}</span>;
          const puedeQuitar = p.rol !== 'dueño' && !soy && (dueno || p.rol === 'alumno');
          const puedeTransferir = dueno && p.rol === 'profesor';
          return (
            <div className={`persona${p.suspendida ? ' ins-suspendida' : ''}`} key={p.id} data-usuario={p.id}>
              <Avatar nombre={p.nombre} clave={p.email} />
              <div className="nm">
                <b>{p.nombre}</b>
                <small>
                  {p.email}
                  {p.pendiente ? ' · pendiente' : ''}
                  {p.suspendida ? ' · suspendida' : ''}
                </small>
              </div>
              {puedeTransferir && (
                <button className="btn sec chico" data-transferir={p.id} onClick={() => setConfirmar({ tipo: 'transferir', id: p.id })}>
                  Hacer dueño
                </button>
              )}
              {control}
              {puedeQuitar ? (
                <button className="x" data-quitar={p.id} title="Quitar" aria-label={`Quitar a ${p.nombre}`} onClick={() => setConfirmar({ tipo: 'quitar', id: p.id })}>
                  &#x2715;
                </button>
              ) : (
                <span style={{ width: 26, flex: 'none' }}></span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
