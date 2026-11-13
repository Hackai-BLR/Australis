import { useCallback, useState } from 'react';
import { Modal, avisarError } from './comun';

export interface PedidoConfirmacion {
  titulo: string;
  texto: string;
  verbo: string;
  peligro?: boolean;
  hacer: () => Promise<void>;
}

export function Confirmar({ pedido, alCerrar }: { pedido: PedidoConfirmacion; alCerrar: () => void }) {
  const confirmar = () => {
    alCerrar();
    pedido.hacer().catch(avisarError);
  };
  return (
    <Modal id="modal" alCerrar={alCerrar}>
      <h3>{pedido.titulo}</h3>
      <p className="desc">{pedido.texto}</p>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className={`btn prim${pedido.peligro ? ' rojo' : ''}`} data-confirmar onClick={confirmar} autoFocus>
          {pedido.verbo}
        </button>
      </div>
    </Modal>
  );
}

export function useConfirmar() {
  const [pedido, setPedido] = useState<PedidoConfirmacion | null>(null);
  const pedir = useCallback((p: PedidoConfirmacion) => setPedido(p), []);
  const elemento = pedido ? <Confirmar pedido={pedido} alCerrar={() => setPedido(null)} /> : null;
  return { pedir, elemento };
}
