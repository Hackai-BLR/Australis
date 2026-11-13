import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../../shared/api";
import { ROLE_LABELS } from "../../shared/auth";
import { Badge, Card, EmptyState, PageHeader, Spinner, Table } from "../../shared/ui";
import { STATUS } from "./status";
import type { PersonDetail } from "./types";

const MEMBER_ROLE = { professor: "Docente", guest: "Docente invitado", student: "Estudiante" };

/** One person and the campuses they belong to (read-only). */
export function PersonPage() {
  const { id } = useParams();
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPerson(null);
    setError(null);
    apiGet<PersonDetail>(`/admin/people/${id}`)
      .then((p) => {
        if (live) setPerson(p);
      })
      .catch(() => {
        if (live) setError("No se pudo cargar a la persona.");
      });
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <>
      <p>
        <Link to="/admin/campuses">← Todos los campus</Link>
      </p>
      {error && (
        <p className="au-field__error" role="alert">
          {error}
        </p>
      )}
      {!person && !error && <Spinner />}
      {person && (
        <>
          <PageHeader
            title={person.full_name}
            subtitle={`${person.email} · ${ROLE_LABELS[person.role]}`}
            actions={<Badge tone={STATUS[person.status].tone}>{STATUS[person.status].label}</Badge>}
          />
          <Card title="Campus">
            {person.memberships.length === 0 ? (
              <EmptyState title="No pertenece a ningún campus" />
            ) : (
              <Table caption="Campus de la persona">
                <thead>
                  <tr>
                    <th>Campus</th>
                    <th>Rol</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {person.memberships.map((m) => (
                    <tr key={m.campus_id}>
                      <td>
                        <Link to={`/campuses/${m.campus_id}`}>{m.campus_name}</Link>
                      </td>
                      <td>{MEMBER_ROLE[m.role]}</td>
                      <td>
                        {m.status === "suspended" ? (
                          <Badge tone="danger">
                            {m.suspended_reason
                              ? `Suspendido: ${m.suspended_reason}`
                              : "Suspendido"}
                          </Badge>
                        ) : (
                          <Badge tone="success">Activo</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}
