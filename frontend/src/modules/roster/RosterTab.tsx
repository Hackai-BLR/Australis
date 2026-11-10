import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ApiError, apiGet, apiPost } from "../../shared/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Table,
  type BadgeTone,
} from "../../shared/ui";
import { CopyButton, ImportWizard } from "./ImportWizard";
import { MEMBER_ROLE_LABELS, type Member } from "./types";

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function statusOf(m: Member): { label: string; tone: BadgeTone } {
  if (m.status === "suspended") return { label: "Suspendido", tone: "danger" };
  if (m.user_status === "invited") return { label: "Pendiente de activar", tone: "info" };
  return { label: "Activo", tone: "success" };
}

/** Members of the campus (students and teachers), the import wizard and guest teachers. */
export function RosterTab() {
  const { id = "" } = useParams();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [addingTeacher, setAddingTeacher] = useState(false);
  const [target, setTarget] = useState<Member | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers(await apiGet<Member[]>(`/campuses/${id}/members`));
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err, "No se pudo cargar la lista."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const reinvite = async (m: Member) => {
    try {
      const res = await apiPost<{ invite_url: string }>(
        `/campuses/${id}/members/${m.user_id}/invite`,
      );
      setLink({ name: m.full_name, url: res.invite_url });
    } catch (err) {
      setNotice({ text: message(err, "No se pudo generar el enlace."), error: true });
    }
  };

  return (
    <>
      <PageHeader
        title="Estudiantes del campus"
        subtitle="Quiénes forman parte del curso."
        actions={
          <>
            <Button variant="secondary" onClick={() => setAddingTeacher(true)}>
              Agregar docente invitado
            </Button>
            <Button onClick={() => setImporting(true)}>Importar estudiantes</Button>
          </>
        }
      />
      {importing && (
        <ImportWizard
          campusId={id}
          onClose={() => setImporting(false)}
          onImported={() => void load()}
        />
      )}
      {link && (
        <Card title="Nuevo enlace de invitación">
          <p style={{ marginTop: 0 }}>
            Enlace para {link.name}. Los anteriores dejaron de funcionar.
          </p>
          <div className="au-row">
            <code>{link.url}</code>
            <CopyButton text={link.url} />
          </div>
        </Card>
      )}
      {notice && (
        <p
          className={notice.error ? "au-field__error" : undefined}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      {loadError && (
        <p className="au-field__error" role="alert">
          {loadError}
        </p>
      )}
      {!members && !loadError && <Spinner />}
      {members && members.length === 0 && (
        <EmptyState
          title="Todavía no hay estudiantes"
          description="Importá una lista para empezar."
        />
      )}
      {members && members.length > 0 && (
        <Table caption="Miembros del curso">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Correo</th>
              <th>Rol</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const status = statusOf(m);
              return (
                <tr key={m.user_id}>
                  <td>{m.full_name}</td>
                  <td>{m.email}</td>
                  <td>{MEMBER_ROLE_LABELS[m.role]}</td>
                  <td>
                    <Badge tone={status.tone} title={m.suspended_reason ?? undefined}>
                      {status.label}
                    </Badge>
                    {m.suspended_reason && <div>Motivo: {m.suspended_reason}</div>}
                  </td>
                  <td className="au-row">
                    {m.role === "student" &&
                      m.status === "active" &&
                      m.user_status === "invited" && (
                        <Button size="sm" variant="secondary" onClick={() => void reinvite(m)}>
                          Nuevo enlace
                        </Button>
                      )}
                    {m.role !== "professor" && (
                      <Button
                        size="sm"
                        variant={m.status === "suspended" ? "secondary" : "danger"}
                        onClick={() => setTarget(m)}
                      >
                        {m.status === "suspended" ? "Reactivar" : "Suspender"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <ReasonModal
        campusId={id}
        member={target}
        onClose={() => setTarget(null)}
        onDone={() => {
          setTarget(null);
          setNotice({ text: "Estado actualizado.", error: false });
          void load();
        }}
      />
      <TeacherModal
        campusId={id}
        open={addingTeacher}
        onClose={() => setAddingTeacher(false)}
        onDone={() => {
          setAddingTeacher(false);
          setNotice({ text: "Docente invitado agregado.", error: false });
          void load();
        }}
      />
    </>
  );
}

function ReasonModal({
  campusId,
  member,
  onClose,
  onDone,
}: {
  campusId: string;
  member: Member | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suspending = member?.status !== "suspended";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!member) return;
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiPost(
        `/campuses/${campusId}/members/${member.user_id}/${suspending ? "suspend" : "reactivate"}`,
        { reason: reason.trim() },
      );
      setReason("");
      onDone();
    } catch (err) {
      setError(message(err, "No se pudo cambiar el estado."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={member !== null}
      title={suspending ? "Suspender del curso" : "Reactivar en el curso"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="member-reason-form"
            variant={suspending ? "danger" : "primary"}
            loading={busy}
          >
            {suspending ? "Suspender" : "Reactivar"}
          </Button>
        </>
      }
    >
      <form id="member-reason-form" className="au-stack" onSubmit={submit} noValidate>
        <p style={{ margin: 0 }}>
          {member?.full_name}. La persona no se elimina: queda registrada con quién, cuándo y por
          qué.
        </p>
        <Input
          label="Motivo"
          value={reason}
          error={error ?? undefined}
          onChange={(e) => setReason(e.target.value)}
        />
      </form>
    </Modal>
  );
}

function TeacherModal({
  campusId,
  open,
  onClose,
  onDone,
}: {
  campusId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/campuses/${campusId}/teachers`, { email: email.trim() });
      setEmail("");
      onDone();
    } catch (err) {
      setError(message(err, "No se pudo agregar al docente."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Agregar docente invitado"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="guest-teacher-form" loading={busy}>
            Agregar
          </Button>
        </>
      }
    >
      <form id="guest-teacher-form" className="au-stack" onSubmit={submit} noValidate>
        <Input
          label="Correo del docente"
          hint="Debe ser una cuenta de docente que ya exista."
          type="email"
          value={email}
          error={error ?? undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
      </form>
    </Modal>
  );
}
