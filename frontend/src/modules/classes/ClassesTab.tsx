import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { apiErrorMessage } from "../../shared/errors";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SimulatedBadge,
  Spinner,
  Table,
} from "../../shared/ui";
import { useCampusAccess } from "../campus";
import { createClass, formatStart, listClasses, localToUtcIso, type ClassItem } from "./api";

function NewClassForm({ campusId, onCreated }: { campusId: string; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("18:00");
  const [duration, setDuration] = useState("90");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!title.trim() || !date || !time) {
      setError("Completá el título, la fecha y la hora.");
      return;
    }
    setBusy(true);
    try {
      await createClass(campusId, {
        title: title.trim(),
        starts_at: localToUtcIso(date, time),
        duration_min: Number(duration),
        join_url: link.trim() || undefined,
      });
      setTitle("");
      setLink("");
      onCreated();
    } catch (e) {
      setError(apiErrorMessage(e, "No se pudo crear la clase."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Nueva clase">
      <form className="au-stack" onSubmit={submit}>
        <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="au-row">
          <Input label="Fecha" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Hora" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <Input
            label="Duración (minutos)"
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
        <Input
          label="Enlace de reunión (opcional)"
          hint="Si lo dejás vacío se crea una reunión de Zoom."
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://"
        />
        {error && <p role="alert">{error}</p>}
        <div>
          <Button type="submit" loading={busy}>
            Crear clase
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ClassesTab() {
  const { id = "" } = useParams();
  const access = useCampusAccess(id);
  const [items, setItems] = useState<ClassItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    listClasses(id)
      .then(setItems)
      .catch((e: unknown) => setError(apiErrorMessage(e, "Error")));
  }, [id]);

  useEffect(load, [load]);

  if (error) return <EmptyState title="No se pudieron cargar las clases" description={error} />;
  return (
    <div className="au-stack">
      {access && access !== "view" && (
        <>
          <p style={{ margin: 0 }}>
            Las reuniones usan tu cuenta de Zoom. <Link to="/zoom">Conectar Zoom</Link>
          </p>
          <NewClassForm campusId={id} onCreated={load} />
        </>
      )}
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="Todavía no hay clases"
          description="Cuando se cree una clase, vas a ver acá su fecha y el botón para entrar."
        />
      ) : (
        <Table caption="Clases">
          <thead>
            <tr>
              <th>Clase</th>
              <th>Fecha</th>
              <th>Duración</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/classes/${c.id}`}>{c.title}</Link>{" "}
                  {c.simulated && <SimulatedBadge detail="Reunión de Zoom simulada." />}
                </td>
                <td>{formatStart(c.starts_at)}</td>
                <td>{c.duration_min} min</td>
                <td>{c.ended_at && <Badge>Finalizada</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
