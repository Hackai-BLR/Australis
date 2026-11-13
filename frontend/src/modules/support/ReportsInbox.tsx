import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../shared/api";
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from "../../shared/ui";
import { listReports, setReportStatus, type Report, type ReportStatus } from "./api";
import "./support.css";

/** Inbox of reports addressed to the signed-in professor or secretary. */
export function ReportsInbox() {
  const [status, setStatus] = useState<ReportStatus>("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReports(await listReports(status));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudieron cargar los reportes.");
    }
  }, [status]);

  useEffect(() => {
    setReports(null);
    void load();
  }, [load]);

  const change = async (report: Report, next: ReportStatus) => {
    try {
      await setReportStatus(report.id, next);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo actualizar el reporte.");
    }
  };

  return (
    <>
      <PageHeader title="Reportes" subtitle="Problemas que reportaron los usuarios." />
      <div className="au-row" role="group" aria-label="Estado">
        <Button
          variant={status === "open" ? "primary" : "secondary"}
          size="sm"
          aria-pressed={status === "open"}
          onClick={() => setStatus("open")}
        >
          Abiertos
        </Button>
        <Button
          variant={status === "resolved" ? "primary" : "secondary"}
          size="sm"
          aria-pressed={status === "resolved"}
          onClick={() => setStatus("resolved")}
        >
          Resueltos
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!reports && !error && <Spinner />}
      {reports && reports.length === 0 && (
        <EmptyState
          title={status === "open" ? "No hay reportes abiertos" : "No hay reportes resueltos"}
        />
      )}
      {reports?.map((report) => (
        <Card
          key={report.id}
          title={report.reporter_name}
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => change(report, report.status === "open" ? "resolved" : "open")}
            >
              {report.status === "open" ? "Marcar como resuelto" : "Reabrir"}
            </Button>
          }
        >
          <p className="au-report-body">{report.body}</p>
          <p className="au-report-meta">
            <Badge tone={report.status === "open" ? "warning" : "success"}>
              {report.status === "open" ? "Abierto" : "Resuelto"}
            </Badge>{" "}
            <Link to={report.page}>{report.page}</Link>
            {report.campus_id !== null && <> · campus {report.campus_id}</>} · {report.created_at}
          </p>
        </Card>
      ))}
    </>
  );
}
