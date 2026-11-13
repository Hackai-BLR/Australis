import { useEffect, useState } from "react";
import { apiErrorMessage } from "../../shared/errors";
import { Button, Card, PageHeader, SimulatedBadge, Spinner } from "../../shared/ui";
import { connectZoom, getZoomConnection, type ZoomConnection } from "./api";

export function ZoomConnectPage() {
  const [connection, setConnection] = useState<ZoomConnection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getZoomConnection()
      .then((value) => alive && setConnection(value))
      .catch((e: unknown) => alive && setError(apiErrorMessage(e, "Error")));
    return () => {
      alive = false;
    };
  }, []);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      setConnection(await connectZoom());
    } catch (e) {
      setError(apiErrorMessage(e, "No se pudo conectar Zoom."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="au-stack">
      <PageHeader
        title="Zoom"
        subtitle="Conectá tu cuenta una sola vez para crear reuniones de clase."
        badge={connection?.simulated ? <SimulatedBadge detail="Conexión simulada." /> : undefined}
      />
      <Card title="Conexión">
        {error && <p role="alert">{error}</p>}
        {!connection ? (
          !error && <Spinner />
        ) : connection.connected ? (
          <p style={{ margin: 0 }}>Zoom está conectado. Ya podés crear clases con reunión.</p>
        ) : (
          <div className="au-stack">
            <p style={{ margin: 0 }}>Todavía no conectaste Zoom.</p>
            <div>
              <Button loading={busy} onClick={connect}>
                Conectar Zoom
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
