import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../../shared/api";
import { useAuth } from "../../shared/auth";
import {
  allGradeKeys,
  pickStep,
  type CampusItem,
  type ClassRow,
  type MyGrades,
  type Step,
  type TodayItem,
} from "./nextStepLogic";
import { Button, Card, SimulatedBadge, Spinner } from "../../shared/ui";

function readSeen<T extends number | string>(key: string, type: "number" | "string"): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is T => typeof n === type) : [];
  } catch {
    return [];
  }
}

function markSeen<T extends number | string>(key: string, ids: T[], type: "number" | "string") {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set([...readSeen<T>(key, type), ...ids])]));
  } catch {
    // Storage can be blocked; the card then simply shows again.
  }
}

function time(value: string): string {
  return new Date(value.replace(" ", "T") + "Z").toLocaleTimeString("es-AR", {
    timeStyle: "short",
  });
}

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** "Tu próximo paso": one card with the most urgent thing for the student. */
export function NextStep() {
  const { user } = useAuth();
  const uid = user?.id ?? 0;
  const recKey = `australis.next.rec.${uid}`;
  const gradeKey = `australis.next.grades.${uid}`;
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [today, campuses, grades] = await Promise.all([
        orNull(apiGet<TodayItem[]>("/classes/today")),
        orNull(apiGet<CampusItem[]>("/campuses")),
        orNull(apiGet<MyGrades>("/grades/mine")),
      ]);
      const lists = await Promise.all(
        (campuses ?? []).map((c) => orNull(apiGet<ClassRow[]>(`/campuses/${c.id}/classes`))),
      );
      const classes = lists.flatMap((l) => l ?? []);
      // Grades have no date in the API, so "new" means "not seen in this browser".
      // On a browser with no stored state (first sign-in, new device) everything
      // already graded is baselined as seen, so only later changes count as new.
      // Recordings use their class date instead: only the last RECENT_DAYS count.
      try {
        if (grades && localStorage.getItem(gradeKey) === null) {
          markSeen(gradeKey, allGradeKeys(grades), "string");
        }
      } catch {
        // Storage blocked: nothing to baseline.
      }
      if (alive)
        setStep(
          pickStep(
            today ?? [],
            classes,
            grades,
            readSeen<number>(recKey, "number"),
            readSeen<string>(gradeKey, "string"),
          ),
        );
    })();
    return () => {
      alive = false;
    };
  }, [recKey, gradeKey]);

  return (
    <Card title="Tu próximo paso">
      {step === null ? (
        <Spinner />
      ) : step.kind === "class" ? (
        <div className="au-row">
          <span>
            Hoy a las {time(step.item.starts_at)}:{" "}
            <Link to={`/classes/${step.item.id}`}>{step.item.title}</Link> · {step.item.campus_name}{" "}
            {step.item.simulated && <SimulatedBadge detail="Reunión de Zoom simulada." />}
          </span>
          <a href={step.item.join_url} target="_blank" rel="noreferrer">
            <Button size="sm">Unirme a la clase</Button>
          </a>
        </div>
      ) : step.kind === "recording" ? (
        <div className="au-row">
          <span>
            Ya está la grabación de {step.item.title} · {step.item.campus_name}{" "}
            {step.item.simulated && <SimulatedBadge detail="Grabación de Zoom simulada." />}
          </span>
          <Link
            to={`/classes/${step.item.id}`}
            className="au-btn au-btn--secondary"
            onClick={() => markSeen(recKey, [step.item.id], "number")}
          >
            Ver la grabación
          </Link>
        </div>
      ) : step.kind === "grade" ? (
        <div className="au-row">
          <span>
            {step.count === 1 ? "Tenés una nota nueva" : `Tenés ${step.count} notas nuevas`} en{" "}
            {step.campus}
            {step.otherCourses > 0 &&
              ` y ${step.otherCourses} ${step.otherCourses === 1 ? "curso más" : "cursos más"}`}
          </span>
          <Link
            to="/grades"
            className="au-btn au-btn--secondary"
            onClick={() => markSeen(gradeKey, step.keys, "string")}
          >
            Ver mis notas
          </Link>
        </div>
      ) : (
        <p>Estás al día: no hay nada urgente por ahora.</p>
      )}
    </Card>
  );
}
