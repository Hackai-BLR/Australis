import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, EmptyState, SimulatedBadge, Spinner } from "../../shared/ui";
import { classesToday, formatTime, type ClassItem } from "./api";

/** "Clase de hoy": today's classes in the user's campuses, each with its join/start button. */
export function TodayClass() {
  const [items, setItems] = useState<ClassItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    classesToday()
      .then((value) => alive && setItems(value))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card title="Clase de hoy">
      {failed ? (
        <EmptyState title="No se pudieron cargar las clases de hoy" />
      ) : items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="Hoy no hay clases" />
      ) : (
        <ul className="au-stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((c) => (
            <li key={c.id} className="au-row">
              <span>
                <Link to={`/classes/${c.id}`}>{c.title}</Link> · {c.campus_name} ·{" "}
                {formatTime(c.starts_at)}{" "}
                {c.simulated && <SimulatedBadge detail="Reunión de Zoom simulada." />}
              </span>
              <a href={c.start_url ?? c.join_url} target="_blank" rel="noreferrer">
                <Button size="sm">
                  {c.can_teach ? "Iniciar clase" : "Unirme a la clase de hoy"}
                </Button>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
