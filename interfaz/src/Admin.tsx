import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorApi, borrar, esCancelado, get, post, put, type Usuario } from './api';
import { Avatar, BotonPerfil, Marca, Modal, avisar, avisarError, fechaCorta, usd, useMenu, type Navegacion } from './comun';
import { useConfirmar } from './Confirmar';
import { CuposDeAdministracion } from './Cupos';
import { SesionesPersona } from './Sesiones';
import { CeldaAccionCursoAdmin, CeldaAccionesPersona, CeldaEstado, ChipsEstado, ModalTransferir, PastillaArchivado, pasaFiltroEstado, type EstadoCuenta, type FiltroEstado } from './Inhabilitar';

type ConUni = (ruta: string) => string;

interface UniversidadAdmin {
  id: number;
  nombre: string;
  dominios: string[];
  cupo_tokens?: number;
}

interface Persona {
  id: number;
  email: string;
  nombre: string;
  profesor: boolean;
  administrador: boolean;
  pendiente: boolean;
  cursos: number;
  ultimo_ingreso: string | null;
  owner?: boolean;
  estado?: EstadoCuenta;
  baja?: boolean;
}

interface CursoAdmin {
  id: string;
  tipo?: 'libre' | 'modulos';
  nombre: string;
  periodo: string;
  color: string;
  dueno: { id: number; nombre: string; email: string } | null;
  profesores: number;
  alumnos: number;
  version_publicada: number | null;
  uso_usd_mes: number;
  archivado?: boolean;
  campus_externo?: number;
}

interface Evento {
  id: number;
  fecha: string;
  actor: { id: number; nombre: string; email: string } | null;
  accion: string;
  detalle: string;
  ip: string | null;
}

type Tab = 'personas' | 'cursos' | 'cupos' | 'config' | 'actividad';
type Filtro = 'todos' | 'prof' | 'admin';

const ACCIONES: Record<string, string> = {
  login: 'entró',
  sesiones_cerradas: 'cerró sesiones',
  token_creado: 'creó un token',
  token_revocado: 'revocó un token',
  marca_profesor: 'marcó como profesor',
  quita_profesor: 'quitó la marca de profesor',
  invitacion_profesor: 'invitó a un profesor',
  invitacion_administrador: 'invitó a un administrador',
  dominio_agregado: 'agregó un dominio',
  dominio_quitado: 'quitó un dominio',
  limite_cambiado: 'cambió el límite de uso',
  sesion_cerrada: 'cerró una sesión',
  cupo_universidad: 'cambió el cupo de la universidad',
  cupo_predeterminado: 'cambió el cupo predeterminado',
  cupo_profesor: 'cambió el cupo de un profesor',
  confirmacion_pedida: 'pidió una confirmación',
  confirmacion_rechazada: 'canceló un pedido del agente',
  desinscripcion: 'quitó a una persona de un curso',
  rol_en_curso: 'cambió un rol en un curso',
  cuenta_suspendida: 'suspendió una cuenta',
  cuenta_reactivada: 'reactivó una cuenta',
  baja_universidad: 'dio de baja una cuenta',
  universidad_deshabilitada: 'deshabilitó la universidad',
  universidad_rehabilitada: 'rehabilitó la universidad',
  curso_archivado: 'archivó un curso',
  curso_desarchivado: 'desarchivó un curso',
  universidad_creada: 'creó la universidad',
  proveedores_cambiados: 'cambió los proveedores',
  owner_creado: 'creó el owner',
  administrador_quitado: 'quitó un administrador',
  owner_agregado: 'agregó un owner',
  owner_quitado: 'quitó un owner',
  curso_transferido: 'transfirió un curso',
};

export function accionEnPalabras(accion: string) {
  return ACCIONES[accion] ?? accion.replace(/_/g, ' ');
}

export function ModalInvitar({
  tipo,
  dominio,
  enviar,
  alCerrar,
}: {
  tipo: 'profesor' | 'administrador';
  dominio?: string;
  enviar: (email: string) => Promise<void>;
  alCerrar: () => void;
}) {
  const [mail, setMail] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const textos =
    tipo === 'profesor'
      ? ['Invitar profesor', 'Le llega un mail para entrar. Ya queda marcado como profesor y puede crear cursos.']
      : ['Invitar administrador', 'Puede marcar profesores y ver todos los cursos y personas de la universidad.'];
  const confirmar = async () => {
    if (ocupado) return;
    const m = mail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m)) {
      setError('Revisá el mail.');
      return;
    }
    setError('');
    setOcupado(true);
    try {
      await enviar(m);
      alCerrar();
      avisar(`Invitación enviada a ${m}`);
    } catch (e) {
      if (!esCancelado(e)) setError(e instanceof ErrorApi ? e.mensaje : 'No se pudo enviar la invitación.');
    } finally {
      setOcupado(false);
    }
  };
  return (
    <Modal alCerrar={alCerrar}>
      <h3>{textos[0]}</h3>
      <p className="desc">{textos[1]}</p>
      <label className="etq" htmlFor="i-mail">
        Mail
      </label>
      <input
        className="campo"
        id="i-mail"
        placeholder={`nombre@${dominio ?? 'universidad.edu.ar'}`}
        value={mail}
        onChange={(e) => setMail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void confirmar();
        }}
      />
      <div className="err" id="i-err">
        {error}
      </div>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className="btn prim" data-invok={tipo} onClick={() => void confirmar()} disabled={ocupado}>
          Enviar invitación
        </button>
      </div>
    </Modal>
  );
}

function Personas({ uni, yo, esOwner, conUni }: { uni: UniversidadAdmin | null; yo: number; esOwner: boolean; conUni: ConUni }) {
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [estado, setEstado] = useState<FiltroEstado>('todas');
  const confirmar = useConfirmar();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [invitar, setInvitar] = useState<'profesor' | 'administrador' | null>(null);
  const [cambiando, setCambiando] = useState<number | null>(null);
  const [sesiones, setSesiones] = useState<Persona | null>(null);
  const turno = useRef(0);

  const cargar = useCallback(async () => {
    const mio = ++turno.current;
    const f = { todos: 'todos', prof: 'profesores', admin: 'administradores' }[filtro];
    try {
      const r = await get<{ personas: Persona[] }>(conUni(`/api/admin/personas?buscar=${encodeURIComponent(busca.trim())}&filtro=${f}&estado=${estado}`));
      if (mio === turno.current) setPersonas(r.personas);
    } catch (e) {
      if (mio === turno.current) avisarError(e);
    }
  }, [busca, filtro, estado, conUni]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const marcar = async (p: Persona) => {
    if (cambiando !== null) return;
    setCambiando(p.id);
    try {
      const nueva = await put<Persona>(conUni(`/api/admin/personas/${p.id}/profesor`), { profesor: !p.profesor });
      setPersonas((lista) => lista?.map((x) => (x.id === nueva.id ? nueva : x)) ?? lista);
      avisar(nueva.profesor ? `${nueva.nombre} ahora puede crear cursos` : `${nueva.nombre} ya no puede crear cursos`);
    } catch (e) {
      avisarError(e);
    } finally {
      setCambiando(null);
    }
  };

  return (
    <>
      <div className="titulo">
        <h2>Personas</h2>
        {personas && <span className="pill">{personas.length}</span>}
        <div className="acciones">
          <button className="btn sec" data-accion="invitar-admin" onClick={() => setInvitar('administrador')}>
            Invitar administrador
          </button>
          <button className="btn prim" data-accion="invitar-prof" onClick={() => setInvitar('profesor')}>
            Invitar profesor
          </button>
        </div>
      </div>
      <div className="filtros">
        <input className="campo" id="busca" placeholder="Buscar por nombre o mail" value={busca} onChange={(e) => setBusca(e.target.value)} />
        {(
          [
            ['todos', 'Todos'],
            ['prof', 'Profesores'],
            ['admin', 'Administradores'],
          ] as [Filtro, string][]
        ).map(([f, t]) => (
          <button key={f} className={`chip${filtro === f ? ' on' : ''}`} data-filtro={f} onClick={() => setFiltro(f)}>
            {t}
          </button>
        ))}
        <ChipsEstado valor={estado} alCambiar={setEstado} />
      </div>
      <div className="caja">
        <table className="tabla">
          <thead>
            <tr>
              <th>Persona</th>
              <th>Profesor</th>
              <th>Cursos</th>
              <th>Último ingreso</th>
              <th>Estado</th>
              {esOwner && <th></th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(personas ?? []).filter((p) => pasaFiltroEstado(p, estado)).map((p) => (
              <tr key={p.id} data-persona={p.id}>
                <td>
                  <div className="per">
                    <Avatar nombre={p.nombre} clave={p.email} />
                    <div>
                      {p.nombre}
                      {p.administrador && (
                        <>
                          {' '}
                          <span className="pill azul">Administrador</span>
                        </>
                      )}
                      {p.pendiente && (
                        <>
                          {' '}
                          <span className="pill ambar">Invitación enviada</span>
                        </>
                      )}
                      <small>{p.email}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <button
                    className={`sw${p.profesor ? ' on' : ''}`}
                    data-marca={p.id}
                    aria-pressed={p.profesor ? 'true' : 'false'}
                    aria-label={`Profesor: ${p.nombre}`}
                    disabled={cambiando === p.id}
                    onClick={() => void marcar(p)}
                  ></button>
                </td>
                <td className="num">{p.cursos}</td>
                <td className="num">{fechaCorta(p.ultimo_ingreso)}</td>
                <CeldaEstado p={p} />
                {esOwner && (
                  <td className="der">
                    <button className="btn sec chico" data-sesiones={p.id} onClick={() => setSesiones(p)}>
                      Sesiones
                    </button>
                  </td>
                )}
                <CeldaAccionesPersona
                  p={p}
                  yo={yo}
                  esOwner={esOwner}
                  conUni={conUni}
                  pedir={confirmar.pedir}
                  alCambiar={async (nueva) => {
                    setPersonas((lista) => lista?.map((x) => (x.id === nueva.id ? { ...x, ...nueva } : x)) ?? lista);
                    await cargar();
                  }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmar.elemento}
      {sesiones && <SesionesPersona persona={sesiones} alCerrar={() => setSesiones(null)} />}
      {invitar && (
        <ModalInvitar
          tipo={invitar}
          dominio={uni?.dominios[0]}
          alCerrar={() => setInvitar(null)}
          enviar={async (email) => {
            await post(conUni('/api/admin/invitaciones'), { email, tipo: invitar });
            await cargar();
          }}
        />
      )}
    </>
  );
}

function Cursos({ dominioBase, conUni }: { dominioBase: string; conUni: ConUni }) {
  const [cursos, setCursos] = useState<CursoAdmin[] | null>(null);
  const [transferir, setTransferir] = useState<CursoAdmin | null>(null);
  const [inscriptos, setInscriptos] = useState<CursoAdmin | null>(null);
  const confirmar = useConfirmar();
  const cargar = useCallback(async () => {
    try {
      const r = await get<{ cursos: CursoAdmin[] }>(conUni('/api/admin/cursos'));
      setCursos(r.cursos);
    } catch (e) {
      avisarError(e);
    }
  }, [conUni]);
  useEffect(() => {
    void cargar();
  }, [cargar]);
  return (
    <>
      <div className="titulo">
        <h2>Cursos</h2>
        {cursos && <span className="pill">{cursos.length}</span>}
      </div>
      <div className="caja">
        <table className="tabla">
          <thead>
            <tr>
              <th>Curso</th>
              <th>Dueño</th>
              <th>Profesores</th>
              <th>Alumnos</th>
              <th>Estado</th>
              <th>Uso del agente este mes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(cursos ?? []).map((c) => (
              <tr key={`${c.tipo ?? 'libre'}-${c.id}`} data-fila-curso={c.id}>
                <td>
                  <div className="per">
                    <span className="punto" style={{ background: c.color, width: 10, height: 10 }}></span>
                    <div>
                      {c.nombre}
                      <small>{c.tipo === 'modulos' ? 'Campus con módulos' : `${c.id}.${dominioBase}`}</small>
                    </div>
                  </div>
                </td>
                <td>{c.dueno?.nombre ?? '—'}</td>
                <td className="num">{c.profesores}</td>
                <td className="num">{c.alumnos}</td>
                <td>{c.tipo === 'modulos' ? <span className="pill">Campus con módulos</span> : c.archivado ? <PastillaArchivado /> : c.version_publicada ? <span className="pill verde">Publicado · v{c.version_publicada}</span> : <span className="pill">Sin publicar</span>}</td>
                <td className="num">USD {usd(c.uso_usd_mes)}</td>
                {c.tipo === 'modulos' ? (
                  <td>
                    <button className="btn" data-inscriptos-campus={c.id} onClick={() => setInscriptos(c)}>
                      Ver inscriptos
                    </button>{' '}
                    {c.campus_externo ? (
                      <a className="btn" data-abrir-campus={c.id} href={`${window.location.protocol}//campus.${dominioBase}${window.location.port ? `:${window.location.port}` : ''}/campuses/${c.campus_externo}`}>
                        Abrir como secretaría
                      </a>
                    ) : null}
                  </td>
                ) : (
                  <CeldaAccionCursoAdmin
                    c={c}
                    conUni={conUni}
                    alTransferir={setTransferir}
                    pedir={confirmar.pedir}
                    alCambiar={(nuevo) => setCursos((lista) => lista?.map((x) => (x.id === nuevo.id && x.tipo !== 'modulos' ? { ...x, ...nuevo } : x)) ?? lista)}
                  />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmar.elemento}
      {inscriptos && <ModalInscriptosCampus c={inscriptos} alCerrar={() => setInscriptos(null)} />}
      {transferir && <ModalTransferir c={transferir} conUni={conUni} alCerrar={() => setTransferir(null)} alTransferir={cargar} />}
    </>
  );
}

interface InscriptoCampus {
  id: number;
  nombre: string;
  email: string;
  rol: string;
  pendiente: boolean;
  suspendida: boolean;
}

function ModalInscriptosCampus({ c, alCerrar }: { c: CursoAdmin; alCerrar: () => void }) {
  const [lista, setLista] = useState<InscriptoCampus[] | null>(null);
  const cerrar = useRef(alCerrar);
  cerrar.current = alCerrar;
  useEffect(() => {
    get<{ inscriptos: InscriptoCampus[] }>(`/api/cursos-modulos/${c.id.replace('campus-', '')}/inscriptos`)
      .then((r) => setLista(r.inscriptos))
      .catch((e) => {
        avisarError(e);
        cerrar.current();
      });
  }, [c.id]);
  return (
    <Modal alCerrar={alCerrar}>
      <h3>Inscriptos · {c.nombre}</h3>
      <table className="tabla" data-inscriptos-lista>
        <thead>
          <tr>
            <th>Persona</th>
            <th>Rol</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {(lista ?? []).map((i) => (
            <tr key={i.id}>
              <td>
                {i.nombre}
                <small>{i.email}</small>
              </td>
              <td>{i.rol}</td>
              <td>{i.suspendida ? 'Suspendida' : i.pendiente ? 'Pendiente' : 'Activa'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="acciones">
        <button className="btn" onClick={alCerrar}>
          Cerrar
        </button>
      </div>
    </Modal>
  );
}

function Configuracion({ uni, alCambiar, conUni }: { uni: UniversidadAdmin | null; alCambiar: (u: UniversidadAdmin) => void; conUni: ConUni }) {
  const [nuevo, setNuevo] = useState('');
  const [ocupado, setOcupado] = useState(false);

  if (!uni) return null;

  const agregar = async () => {
    const d = nuevo.trim().toLowerCase().replace(/^@/, '');
    if (!d || ocupado) return;
    setOcupado(true);
    try {
      const u = await post<UniversidadAdmin>(conUni('/api/admin/dominios'), { dominio: d });
      alCambiar(u);
      setNuevo('');
      avisar(`Agregaste @${d}`);
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };

  const quitar = async (d: string) => {
    try {
      const u = await borrar<UniversidadAdmin>(conUni(`/api/admin/dominios/${encodeURIComponent(d)}`));
      alCambiar(u);
      avisar(`Quitaste @${d}`);
    } catch (e) {
      if (e instanceof ErrorApi && e.codigo === 'ultimo_dominio') avisar('La universidad necesita al menos un dominio');
      else avisarError(e);
    }
  };

  return (
    <>
      <div className="titulo">
        <h2>Configuración</h2>
      </div>
      <div className="bloque">
        <h3>Dominios de mail habilitados</h3>
        <p className="desc">Quien tenga un mail de estos dominios puede entrar. La cuenta se crea la primera vez.</p>
        <div className="dominios">
          {uni.dominios.map((d) => (
            <span className="dom" key={d}>
              @{d}
              <button data-quitardom={d} aria-label={`Quitar @${d}`} onClick={() => void quitar(d)}>
                &#x2715;
              </button>
            </span>
          ))}
          <div className="fila">
            <input
              className="campo"
              id="nuevo-dom"
              placeholder="ejemplo.edu.ar"
              style={{ width: 180, height: 32 }}
              value={nuevo}
              onChange={(e) => setNuevo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void agregar();
              }}
            />
            <button className="btn sec chico" data-accion="agregar-dom" onClick={() => void agregar()}>
              Agregar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function Actividad({ conUni }: { conUni: ConUni }) {
  const [eventos, setEventos] = useState<Evento[] | null>(null);
  useEffect(() => {
    get<{ eventos: Evento[] }>(conUni('/api/admin/auditoria?limite=100'))
      .then((r) => setEventos(r.eventos))
      .catch(avisarError);
  }, [conUni]);
  return (
    <>
      <div className="titulo">
        <h2>Actividad</h2>
      </div>
      <div className="caja">
        {eventos && eventos.length === 0 && <div className="log">Sin actividad todavía.</div>}
        {(eventos ?? []).map((ev) => (
          <div className="log" key={ev.id}>
            <time dateTime={ev.fecha}>{fechaCorta(ev.fecha, true)}</time>
            <div>
              <b style={{ fontWeight: 500 }}>{ev.actor?.nombre ?? 'Sistema'}</b> {accionEnPalabras(ev.accion)} <span>{ev.detalle}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function uniDeLaUrl(): number | null {
  const v = new URLSearchParams(window.location.search).get('universidad');
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function Admin({ usuario, nav, dominioBase }: { usuario: Usuario; nav: Navegacion; dominioBase: string }) {
  const menu = useMenu();
  const [tab, setTab] = useState<Tab>('personas');
  const [uni, setUni] = useState<UniversidadAdmin | null>(null);
  const esOwner = usuario.owner;
  const [opciones, setOpciones] = useState<{ id: number; nombre: string }[] | null>(null);
  const [elegida, setElegida] = useState<number | null>(() => (esOwner ? uniDeLaUrl() : null));

  useEffect(() => {
    if (!esOwner) return;
    get<{ universidades: { id: number; nombre: string }[] }>('/api/owner/universidades')
      .then((r) => {
        setOpciones(r.universidades);
        setElegida((actual) => {
          if (actual !== null && r.universidades.some((u) => u.id === actual)) return actual;
          const propia = usuario.administrador && usuario.universidad ? usuario.universidad.id : null;
          return propia ?? r.universidades[0]?.id ?? null;
        });
      })
      .catch(avisarError);
  }, [esOwner]);

  const conUni = useCallback<ConUni>(
    (ruta) => (esOwner && elegida !== null ? `${ruta}${ruta.includes('?') ? '&' : '?'}universidad=${elegida}` : ruta),
    [esOwner, elegida],
  );
  const listo = !esOwner || (opciones !== null && elegida !== null);

  useEffect(() => {
    if (!listo) return;
    setUni(null);
    get<UniversidadAdmin>(conUni('/api/admin/universidad'))
      .then(setUni)
      .catch(avisarError);
  }, [conUni, listo]);

  useEffect(() => {
    if (esOwner && elegida !== null && uniDeLaUrl() !== elegida) {
      window.history.replaceState(null, '', `/administracion?universidad=${elegida}`);
    }
  }, [esOwner, elegida]);

  return (
    <section className="vista pagina activa" id="v-admin">
      <div className="cab">
        <Marca alTocar={() => nav.irA(esOwner ? '/owner' : '/')} />
        {esOwner ? (
          <select
            className="selector-uni"
            id="selector-universidad"
            aria-label="Universidad"
            value={elegida ?? ''}
            onChange={(e) => setElegida(Number(e.target.value))}
          >
            {(opciones ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
        ) : (
          <span className="lugar js-uni">{uni?.nombre ?? usuario.universidad?.nombre ?? ''}</span>
        )}
        <div className="tabs" id="tabs-admin">
          {(
            [
              ['personas', 'Personas'],
              ['cursos', 'Cursos'],
              ['cupos', 'Cupos'],
              ['config', 'Configuración'],
              ['actividad', 'Actividad'],
            ] as [Tab, string][]
          ).map(([t, texto]) => (
            <button key={t} className={tab === t ? 'on' : ''} data-tab={t} onClick={() => setTab(t)}>
              {texto}
            </button>
          ))}
        </div>
        <span className="esp"></span>
        <BotonPerfil id="m-perfil-a" usuario={usuario} menu={menu} nav={nav} />
      </div>
      <div className="cuerpo">
        <div className="cont" id="admin-cont" key={elegida ?? 'propia'} data-universidad-admin={elegida ?? undefined}>
          {listo && tab === 'personas' && <Personas uni={uni} yo={usuario.id} esOwner={esOwner} conUni={conUni} />}
          {listo && tab === 'cursos' && <Cursos dominioBase={dominioBase} conUni={conUni} />}
          {listo && tab === 'cupos' && <CuposDeAdministracion conUni={conUni} />}
          {listo && tab === 'config' && <Configuracion uni={uni} alCambiar={setUni} conUni={conUni} />}
          {listo && tab === 'actividad' && <Actividad conUni={conUni} />}
        </div>
      </div>
    </section>
  );
}
