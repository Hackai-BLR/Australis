import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../../shared/api";
import { ROLE_LABELS } from "../../shared/auth";
import {
  Badge,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
} from "../../shared/ui";
import { STATUS } from "./status";
import type { CampusSummary, Person } from "./types";

const ROLE_OPTIONS = [
  { value: "", label: "Todos los roles" },
  { value: "student", label: ROLE_LABELS.student },
  { value: "professor", label: ROLE_LABELS.professor },
  { value: "secretary", label: ROLE_LABELS.secretary },
];

const STATUS_OPTIONS = [
  { value: "", label: "Todos los estados" },
  { value: "active", label: STATUS.active.label },
  { value: "invited", label: STATUS.invited.label },
  { value: "suspended", label: STATUS.suspended.label },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The secretary's read-only overview: every campus and every person, with search and filters. */
export function AllCampusesPage() {
  const [text, setText] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const q = useDebounced(text.trim(), 250);
  const [campuses, setCampuses] = useState<CampusSummary[] | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const campusQuery = new URLSearchParams({ q }).toString();
    const peopleQuery = new URLSearchParams({ q, role, status }).toString();
    Promise.all([
      apiGet<CampusSummary[]>(`/admin/campuses?${campusQuery}`),
      apiGet<Person[]>(`/admin/people?${peopleQuery}`),
    ])
      .then(([c, p]) => {
        if (!live) return;
        setCampuses(c);
        setPeople(p);
        setError(null);
      })
      .catch(() => {
        if (live) setError("No se pudo cargar el listado.");
      });
    return () => {
      live = false;
    };
  }, [q, role, status]);

  return (
    <>
      <PageHeader
        title="Todos los campus"
        subtitle="Campus, docentes y estudiantes de toda la institución. Solo lectura."
      />
      <Card>
        <div className="au-row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <Input
            label="Buscar"
            type="search"
            placeholder="Nombre o correo"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Select
            label="Rol (personas)"
            options={ROLE_OPTIONS}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
          <Select
            label="Estado (personas)"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          />
        </div>
      </Card>
      {error && (
        <p className="au-field__error" role="alert">
          {error}
        </p>
      )}
      {!campuses && !people && !error && <Spinner />}
      {campuses && (
        <Card title="Campus">
          {campuses.length === 0 ? (
            <EmptyState title="No hay campus que coincidan" />
          ) : (
            <Table caption="Campus">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Universidad</th>
                  <th>Docentes</th>
                  <th>Invitados</th>
                  <th>Estudiantes</th>
                  <th>Suspendidos</th>
                </tr>
              </thead>
              <tbody>
                {campuses.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/campuses/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>{c.university_name ?? c.university ?? "—"}</td>
                    <td>{c.professors}</td>
                    <td>{c.guests}</td>
                    <td>{c.students}</td>
                    <td>{c.suspended}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {people && (
        <Card title="Personas">
          {people.length === 0 ? (
            <EmptyState title="No hay personas que coincidan" />
          ) : (
            <Table caption="Personas">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Correo</th>
                  <th>Rol</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/admin/people/${p.id}`}>{p.full_name}</Link>
                    </td>
                    <td>{p.email}</td>
                    <td>{ROLE_LABELS[p.role]}</td>
                    <td>
                      <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
