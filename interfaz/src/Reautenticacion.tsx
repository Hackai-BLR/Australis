import { useEffect, useRef, useState } from 'react';
import { ErrorApi, api, usarReautenticador, type Usuario } from './api';
import { Digitos, Modal, avisar, type ManejoDigitos } from './comun';

interface Pendiente {
  resolver: () => void;
  rechazar: (e: unknown) => void;
}

export function Reautenticacion({ usuario }: { usuario: Usuario }) {
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const pendientes = useRef<Pendiente[]>([]);
  const digitos = useRef<ManejoDigitos>(null);
  const verificando = useRef(false);

  const pedirCodigo = async (reenvio: boolean) => {
    setError('');
    try {
      await api('POST', '/api/reautenticacion/codigo', {}, { reautenticar: false });
      if (reenvio) avisar('Te mandamos otro código');
    } catch (e) {
      if (e instanceof ErrorApi && e.status === 429) setError('Pediste demasiados códigos. Probá en unos minutos.');
      else if (e instanceof ErrorApi) setError(e.mensaje);
      else setError('No se pudo mandar el código.');
    }
  };

  useEffect(() => {
    usarReautenticador(
      () =>
        new Promise<void>((resolver, rechazar) => {
          pendientes.current.push({ resolver, rechazar });
          if (pendientes.current.length === 1) {
            setError('');
            setAbierto(true);
            void pedirCodigo(false);
          }
        }),
    );
    return () => usarReautenticador(null);
  }, []);

  const terminar = (ok: boolean) => {
    const lista = pendientes.current;
    pendientes.current = [];
    setAbierto(false);
    setError('');
    lista.forEach((p) => (ok ? p.resolver() : p.rechazar(new ErrorApi(0, 'cancelado', 'Cancelado'))));
  };

  const verificar = async (codigo: string) => {
    if (verificando.current) return;
    verificando.current = true;
    setOcupado(true);
    setError('');
    try {
      await api('POST', '/api/reautenticacion/verificar', { codigo }, { reautenticar: false });
      terminar(true);
    } catch (e) {
      setError(e instanceof ErrorApi && e.codigo !== 'codigo_invalido' ? e.mensaje : 'El código no es válido o venció.');
      digitos.current?.limpiar();
    } finally {
      verificando.current = false;
      setOcupado(false);
    }
  };

  if (!abierto) return null;
  return (
    <Modal clase="reaut" alCerrar={() => terminar(false)}>
      <h3>Confirmá que sos vos</h3>
      <p className="desc">
        Te mandamos un código a <b>{usuario.email}</b>.
      </p>
      <div style={{ marginTop: 16 }}>
        <Digitos id="reaut-digitos" ref={digitos} alCompletar={verificar} autoFoco />
      </div>
      <div className="err" id="reaut-err">
        {error}
      </div>
      <div className="pie">
        <button className="enlace" style={{ marginRight: 'auto' }} onClick={() => pedirCodigo(true)} disabled={ocupado}>
          Reenviar código
        </button>
        <button className="btn sec" onClick={() => terminar(false)}>
          Cancelar
        </button>
      </div>
    </Modal>
  );
}
