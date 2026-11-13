import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiGet } from "../../shared/api";
import { Badge, Card, EmptyState, PageHeader, Spinner, Table } from "../../shared/ui";
import { formatScore } from "./paste";
import type { MyGradesData } from "./types";

/** The student's grades. With `campusId`, only that course; without, every course. */
export function MyGradesView({ campusId }: { campusId?: number }) {
  const [data, setData] = useState<MyGradesData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<MyGradesData>("/grades/mine")
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : "No se pudieron cargar las notas."),
      );
  }, []);

  if (error) return <EmptyState title="No se pudieron cargar las notas" description={error} />;
  if (!data) return <Spinner />;
  const courses = data.courses.filter((c) => campusId === undefined || c.campus_id === campusId);
  if (courses.length === 0) {
    return (
      <EmptyState
        title="Sin calificaciones por ahora"
        description="Cuando tus docentes carguen notas, las vas a ver acá."
      />
    );
  }
  const scaleOf = (course: (typeof courses)[number]) => course.scale;
  return (
    <div className="au-stack">
      {courses.map((course) => (
        <Card
          key={course.campus_id}
          title={
            campusId === undefined ? (
              <Link to={`/campuses/${course.campus_id}`}>{course.campus_name}</Link>
            ) : (
              "Mis notas"
            )
          }
          actions={
            course.final === null ? (
              <Badge>Sin nota final</Badge>
            ) : (
              <Badge tone={course.final >= scaleOf(course).pass ? "success" : "danger"}>
                Final: {formatScore(course.final)}
              </Badge>
            )
          }
        >
          {course.items.length === 0 ? (
            <p style={{ margin: 0 }}>Todavía no hay evaluaciones cargadas.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Evaluación</th>
                  <th scope="col">Peso</th>
                  <th scope="col">Nota</th>
                </tr>
              </thead>
              <tbody>
                {course.items.map((item) => (
                  <tr key={item.item_id}>
                    <td>{item.title}</td>
                    <td>{formatScore(item.weight)}</td>
                    <td>{formatScore(item.score) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ))}
      {courses.some((course) => scaleOf(course).confirmed === false) && (
        <p className="grades-hint">La escala de notas todavía no fue confirmada por el programa.</p>
      )}
    </div>
  );
}

/** The /grades page: every grade across all the student's courses. */
export function MyGradesPage() {
  return (
    <>
      <PageHeader title="Mis calificaciones" subtitle="Todas tus notas, de todos tus cursos." />
      <MyGradesView />
    </>
  );
}
