import { useCallback, useEffect, useState } from 'react';
import { ErrorApi, borrar, esCancelado, get, post, put, type Usuario } from './api';
import { ModalInvitar } from './Admin';
import { BotonPerfil, Marca, Modal, avisar, avisarError, fechaCorta, usd, useMenu, type Navegacion } from './comun';
import { useConfirmar } from './Confirmar';
import { CuposDelOwner } from './Cupos';
import { BotonesUniversidad, CeldaEstado, pedidoQuitarRol, type EstadoCuenta } from './Inhabilitar';

interface UniversidadOwner {
  id: number;
  nombre: string;
  dominios: string[];
  administradores: { id: number; nombre: string; email: string; pendiente: boolean }[];
  profesores: number;
  personas: number;
  cursos: number;
  deshabilitada?: boolean;
}

interface Uso {
  personas: number;
  cursos: number;
  agente_usd_mes: number;
  mails_hoy: number;
  universidades: { id: number; nombre: string; cursos: number; agente_usd_mes: number }[];
}

interface Proveedores {
  modelo: 'api' | 'suscripcion';
  email: 'brevo' | 'resend';
}

interface EstadoPlataforma {
  nucleo: { ok: boolean; version: string; arranque: string; segundos_activo: number };
  contenedores: { proveedor: 'docker' | 'ninguno'; encendidos: number; cursos: number };
  disco: { total_bytes: number; libres_bytes: number };
  archivos: { cantidad: number; bytes: number };
  respaldo: { ultimo: { nombre: string; fecha: string; bytes: number } | null };
}

type Tab = 'unis' | 'owners' | 'cupos' | 'uso' | 'estado';

interface OwnerLista {
  id: number;
  email: string;
  nombre: string;
  pendiente: boolean;
  estado: EstadoCuenta;
  universidad: string | null;
}

function ModalUniversidad({ alCerrar, alCrear }: { alCerrar: () => void; alCrear: () => Promise<void> }) {
  const [nombre, setNombre] = useState('');
  const [dominio, setDominio] = useState('');
  const [admin, setAdmin] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const crear = async () => {
    if (ocupado) return;
    const n = nombre.trim();
    const d = dominio.trim().toLowerCase().replace(/^@/, '');
    const a = admin.trim().toLowerCase();
    if (!n || !d || !a.endsWith('@' + d)) {
      setError('Completá todo. El mail del administrador tiene que ser de ese dominio.');
      return;
    }
    setError('');
    setOcupado(true);
    try {
      await post('/api/owner/universidades', { nombre: n, dominio: d, email_administrador: a });
      await alCrear();
      alCerrar();
      avisar(`${n} creada. Invitación enviada a ${a}`);
    } catch (e) {
      if (!esCancelado(e)) setError(e instanceof ErrorApi ? e.mensaje : 'No se pudo crear la universidad.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal alCerrar={alCerrar}>
      <h3>Nueva universidad</h3>
      <label className="etq" htmlFor="n-nombre">
        Nombre
      </label>
      <input className="campo" id="n-nombre" placeholder="Universidad de ..." value={nombre} onChange={(e) => setNombre(e.target.value)} />
      <label className="etq" htmlFor="n-dom">
        Dominio de mail
      </label>
      <input className="campo" id="n-dom" placeholder="universidad.edu.ar" value={dominio} onChange={(e) => setDominio(e.target.value)} />
      <label className="etq" htmlFor="n-admin">
        Mail del primer administrador
      </label>
      <input
        className="campo"
        id="n-admin"
        placeholder="nombre@universidad.edu.ar"
        value={admin}
        onChange={(e) => setAdmin(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void crear();
        }}
      />
      <div className="err" id="n-err">
        {error}
      </div>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className="btn prim" data-accion="uni-ok" onClick={() => void crear()} disabled={ocupado}>
          Crear
        </button>
      </div>
    </Modal>
  );
}

function Universidades({ nav }: { nav: Navegacion }) {
  const [unis, setUnis] = useState<UniversidadOwner[] | null>(null);
  const [nueva, setNueva] = useState(false);
  const [invitarEn, setInvitarEn] = useState<UniversidadOwner | null>(null);
  const confirmar = useConfirmar();

  const cargar = useCallback(async () => {
    try {
      const r = await get<{ universidades: UniversidadOwner[] }>('/api/owner/universidades');
      setUnis(r.universidades);
    } catch (e) {
      avisarError(e);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <>
      <div className="titulo">
        <h2>Universidades</h2>
        <div className="acciones">
          <button className="btn prim" data-accion="nueva-uni" onClick={() => setNueva(true)}>
            Nueva universidad
          </button>
        </div>
      </div>
      <div className="caja">
        <table className="tabla">
          <thead>
            <tr>
              <th>Universidad</th>
              <th>Administradores</th>
              <th>Profesores</th>
              <th>Personas</th>
              <th>Cursos</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(unis ?? []).map((u) => (
              <tr key={u.id} data-universidad={u.id}>
                <td>
                  {u.nombre}
                  {u.deshabilitada && (
                    <>
                      {' '}
                      <span className="pill">Deshabilitada</span>
                    </>
                  )}
                  <small style={{ display: 'block', color: 'var(--gris)', fontSize: 12 }}>{u.dominios.map((d) => '@' + d).join(' · ')}</small>
                </td>
                <td>
                  {u.administradores.length ? (
                    u.administradores.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && <br />}
                        {a.nombre}
                        {a.pendiente && (
                          <>
                            {' '}
                            <span className="pill ambar">Invitación enviada</span>
                          </>
                        )}{' '}
                        <button
                          className="btn sec chico"
                          data-quitaradmin={a.id}
                          aria-label={`Quitar a ${a.nombre} como administrador`}
                          onClick={() =>
                            confirmar.pedir(
                              pedidoQuitarRol(a.nombre, 'administrador', ` de ${u.nombre}`, async () => {
                                const nueva = await borrar<UniversidadOwner>(`/api/owner/universidades/${u.id}/administradores/${a.id}`);
                                setUnis((lista) => lista?.map((x) => (x.id === nueva.id ? nueva : x)) ?? lista);
                                avisar(`${a.nombre} ya no es administrador de ${u.nombre}`);
                              }),
                            )
                          }
                        >
                          Quitar
                        </button>
                      </span>
                    ))
                  ) : (
                    <span className="num">—</span>
                  )}
                </td>
                <td className="num">{u.profesores}</td>
                <td className="num">{u.personas}</td>
                <td className="num">{u.cursos}</td>
                <td className="acciones-fila" style={{ textAlign: 'right' }}>
                  <button className="btn sec chico" data-administrar={u.id} onClick={() => nav.irA(`/administracion?universidad=${u.id}`)}>
                    Administrar
                  </button>
                  {!u.deshabilitada && (
                    <button className="btn sec chico" data-invadmin={u.id} onClick={() => setInvitarEn(u)}>
                      Invitar administrador
                    </button>
                  )}
                  <BotonesUniversidad
                    u={u}
                    pedir={confirmar.pedir}
                    alCambiar={async (nueva) => {
                      setUnis((lista) => lista?.map((x) => (x.id === nueva.id ? { ...x, ...nueva } : x)) ?? lista);
                      await cargar();
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmar.elemento}
      {nueva && <ModalUniversidad alCerrar={() => setNueva(false)} alCrear={cargar} />}
      {invitarEn && (
        <ModalInvitar
          tipo="administrador"
          dominio={invitarEn.dominios[0]}
          alCerrar={() => setInvitarEn(null)}
          enviar={async (email) => {
            await post(`/api/owner/universidades/${invitarEn.id}/administradores`, { email });
            await cargar();
          }}
        />
      )}
    </>
  );
}

function ModalOwner({ alCerrar, enviar }: { alCerrar: () => void; enviar: (email: string) => Promise<void> }) {
  const [mail, setMail] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
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
      avisar(`${m} ahora es owner`);
    } catch (e) {
      if (!esCancelado(e)) setError(e instanceof ErrorApi ? e.mensaje : 'No se pudo dar el rol.');
    } finally {
      setOcupado(false);
    }
  };
  return (
    <Modal alCerrar={alCerrar}>
      <h3>Invitar owner</h3>
      <p className="desc">Puede administrar todas las universidades y la plataforma.</p>
      <label className="etq" htmlFor="o-mail">
        Mail
      </label>
      <input
        className="campo"
        id="o-mail"
        placeholder="nombre@dominio.com"
        value={mail}
        onChange={(e) => setMail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void confirmar();
        }}
      />
      <div className="err" id="o-err">
        {error}
      </div>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className="btn prim" data-invok="owner" onClick={() => void confirmar()} disabled={ocupado}>
          Dar rol de owner
        </button>
      </div>
    </Modal>
  );
}

function Owners({ yo, nav }: { yo: number; nav: Navegacion }) {
  const [owners, setOwners] = useState<OwnerLista[] | null>(null);
  const [invitar, setInvitar] = useState(false);
  const confirmar = useConfirmar();

  const cargar = useCallback(async () => {
    try {
      const r = await get<{ owners: OwnerLista[] }>('/api/owner/owners');
      setOwners(r.owners);
    } catch (e) {
      avisarError(e);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <>
      <div className="titulo">
        <h2>Owners</h2>
        {owners && <span className="pill">{owners.length}</span>}
        <div className="acciones">
          <button className="btn prim" data-accion="invitar-owner" onClick={() => setInvitar(true)}>
            Invitar owner
          </button>
        </div>
      </div>
      <div className="caja">
        <table className="tabla">
          <thead>
            <tr>
              <th>Persona</th>
              <th>Universidad</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(owners ?? []).map((o) => (
              <tr key={o.id} data-owner={o.id}>
                <td>
                  {o.nombre}
                  {o.id === yo && (
                    <>
                      {' '}
                      <span className="pill azul">Vos</span>
                    </>
                  )}
                  <small style={{ display: 'block', color: 'var(--gris)', fontSize: 12 }}>{o.email}</small>
                </td>
                <td>{o.universidad ?? '—'}</td>
                <CeldaEstado p={{ ...o, administrador: false }} />
                <td className="acciones-fila" style={{ textAlign: 'right' }}>
                  <button
                    className="btn sec chico peligro"
                    data-quitarowner={o.id}
                    onClick={() =>
                      confirmar.pedir(
                        pedidoQuitarRol(o.nombre, 'owner', ' de Campus IA', async () => {
                          const r = await borrar<{ owners: OwnerLista[] }>(`/api/owner/owners/${o.id}`);
                          avisar(`${o.nombre} ya no es owner`);
                          if (o.id === yo) {
                            nav.salir();
                            return;
                          }
                          setOwners(r.owners);
                        }),
                      )
                    }
                  >
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmar.elemento}
      {invitar && (
        <ModalOwner
          alCerrar={() => setInvitar(false)}
          enviar={async (email) => {
            await post('/api/owner/owners', { email });
            await cargar();
          }}
        />
      )}
    </>
  );
}

function UsoYProveedores() {
  const [uso, setUso] = useState<Uso | null>(null);
  const [prov, setProv] = useState<Proveedores | null>(null);

  useEffect(() => {
    get<Uso>('/api/owner/uso').then(setUso).catch(avisarError);
    get<Proveedores>('/api/owner/proveedores').then(setProv).catch(avisarError);
  }, []);

  const elegir = async (cambio: Partial<Proveedores>) => {
    if (!prov) return;
    const nuevo = { ...prov, ...cambio };
    if (nuevo.modelo === prov.modelo && nuevo.email === prov.email) return;
    const anterior = prov;
    setProv(nuevo);
    try {
      setProv(await put<Proveedores>('/api/owner/proveedores', nuevo));
      avisar('Proveedor guardado');
    } catch (e) {
      setProv(anterior);
      avisarError(e);
    }
  };

  const opciones = <K extends keyof Proveedores>(id: string, clave: K, lista: [Proveedores[K], string][]) => (
    <div className="opciones" id={id}>
      {lista.map(([valor, texto]) => (
        <button
          key={valor}
          className={`chip${prov?.[clave] === valor ? ' on' : ''}`}
          data-op={clave}
          aria-pressed={prov?.[clave] === valor}
          onClick={() => void elegir({ [clave]: valor } as Partial<Proveedores>)}
        >
          {texto}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="titulo">
        <h2>Uso y proveedores</h2>
      </div>
      <div className="metricas">
        <div className="met">
          <small>Personas</small>
          <b>{uso ? uso.personas : '—'}</b>
        </div>
        <div className="met">
          <small>Cursos</small>
          <b>{uso ? uso.cursos : '—'}</b>
        </div>
        <div className="met">
          <small>Agente este mes</small>
          <b>{uso ? `USD ${usd(uso.agente_usd_mes)}` : '—'}</b>
        </div>
        <div className="met">
          <small>Mails hoy</small>
          <b>{uso ? uso.mails_hoy : '—'}</b>
        </div>
      </div>
      <div className="prov">
        <div className="caja">
          <h3 style={{ margin: 0, fontSize: 14 }}>Modelo del agente</h3>
          {opciones('op-modelo', 'modelo', [
            ['api', 'API'],
            ['suscripcion', 'Suscripción del equipo'],
          ])}
        </div>
        <div className="caja">
          <h3 style={{ margin: 0, fontSize: 14 }}>Envío de mails</h3>
          {opciones('op-mail', 'email', [
            ['brevo', 'Brevo'],
            ['resend', 'Resend'],
          ])}
        </div>
      </div>
      <div className="caja" style={{ marginTop: 24 }}>
        <table className="tabla">
          <thead>
            <tr>
              <th>Universidad</th>
              <th>Cursos</th>
              <th>Agente este mes</th>
            </tr>
          </thead>
          <tbody>
            {(uso?.universidades ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.nombre}</td>
                <td className="num">{u.cursos}</td>
                <td className="num">USD {usd(u.agente_usd_mes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function gb(bytes: number) {
  return (bytes / 1e9).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function duracion(segundos: number) {
  const s = Math.max(0, Math.floor(segundos));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function Estado() {
  const [estado, setEstado] = useState<EstadoPlataforma | null>(null);

  useEffect(() => {
    get<EstadoPlataforma>('/api/owner/estado').then(setEstado).catch(avisarError);
  }, []);

  const ultimo = estado?.respaldo.ultimo ?? null;

  return (
    <>
      <div className="titulo">
        <h2>Estado</h2>
      </div>
      <div className="metricas">
        <div className="met" id="estado-nucleo">
          <small>Núcleo</small>
          <b>{estado ? (estado.nucleo.ok ? 'Funcionando' : 'Con problemas') : '—'}</b>
          {estado && <span className="met-sub">Hace {duracion(estado.nucleo.segundos_activo)}</span>}
        </div>
        <div className="met" id="estado-contenedores">
          <small>Contenedores encendidos</small>
          <b>{estado ? estado.contenedores.encendidos : '—'}</b>
          {estado && (
            <span className="met-sub">
              De {estado.contenedores.cursos} {estado.contenedores.cursos === 1 ? 'curso' : 'cursos'}
            </span>
          )}
        </div>
        <div className="met" id="estado-disco">
          <small>Disco</small>
          <b className="met-largo">{estado ? `${gb(estado.disco.libres_bytes)} GB libres de ${gb(estado.disco.total_bytes)} GB` : '—'}</b>
          {estado && (
            <span className="met-sub">
              {estado.archivos.cantidad} {estado.archivos.cantidad === 1 ? 'archivo' : 'archivos'}, {gb(estado.archivos.bytes)} GB
            </span>
          )}
        </div>
        <div className="met" id="estado-respaldo" data-fecha={ultimo ? ultimo.fecha : undefined}>
          <small>Último respaldo</small>
          <b className={ultimo ? undefined : 'met-largo'}>{estado ? (ultimo ? fechaCorta(ultimo.fecha, true) : 'Sin respaldos') : '—'}</b>
          {ultimo && <span className="met-sub">{gb(ultimo.bytes)} GB</span>}
        </div>
      </div>
    </>
  );
}

export function Owner({ usuario, nav }: { usuario: Usuario; nav: Navegacion }) {
  const menu = useMenu();
  const [tab, setTab] = useState<Tab>('unis');
  return (
    <section className="vista pagina activa" id="v-owner">
      <div className="cab">
        <Marca alTocar={() => nav.irA('/owner')} />
        <span className="lugar">Owner</span>
        <div className="tabs" id="tabs-owner">
          <button className={tab === 'unis' ? 'on' : ''} data-otab="unis" onClick={() => setTab('unis')}>
            Universidades
          </button>
          <button className={tab === 'owners' ? 'on' : ''} data-otab="owners" onClick={() => setTab('owners')}>
            Owners
          </button>
          <button className={tab === 'cupos' ? 'on' : ''} data-otab="cupos" onClick={() => setTab('cupos')}>
            Cupos
          </button>
          <button className={tab === 'uso' ? 'on' : ''} data-otab="uso" onClick={() => setTab('uso')}>
            Uso y proveedores
          </button>
          <button className={tab === 'estado' ? 'on' : ''} data-otab="estado" onClick={() => setTab('estado')}>
            Estado
          </button>
        </div>
        <span className="esp"></span>
        <BotonPerfil id="m-perfil-o" usuario={usuario} menu={menu} nav={nav} />
      </div>
      <div className="cuerpo">
        <div className="cont" id="owner-cont">
          {tab === 'unis' ? <Universidades nav={nav} /> : tab === 'owners' ? <Owners yo={usuario.id} nav={nav} /> : tab === 'cupos' ? <CuposDelOwner /> : tab === 'uso' ? <UsoYProveedores /> : <Estado />}
        </div>
      </div>
    </section>
  );
}
