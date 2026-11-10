import { Link, useParams, useSearchParams } from "react-router-dom";
import { Card, PageHeader, SimulatedBadge } from "../../shared/ui";

/** Stand-in for the Zoom meeting that the placeholder provider links to. */
export function SimulatedMeetingPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const host = params.get("anfitrion") === "1";

  return (
    <div className="au-stack">
      <PageHeader
        title="Reunión de Zoom simulada"
        subtitle="Esta es una reunión de demostración."
        badge={
          <SimulatedBadge detail="No hay ninguna reunión real de Zoom detrás de esta página." />
        }
      />
      <Card title="Detalles">
        <div className="au-stack">
          <p style={{ margin: 0 }}>
            Reunión: <strong>{id}</strong>
          </p>
          <p style={{ margin: 0 }}>
            Tu rol: <strong>{host ? "Anfitrión" : "Participante"}</strong>
          </p>
          <p style={{ margin: 0 }}>
            Cuando se conecte una cuenta de Zoom, la reunión real se abrirá acá.
          </p>
          <div>
            <Link to="/">Volver al inicio</Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
