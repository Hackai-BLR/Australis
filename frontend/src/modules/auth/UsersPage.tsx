import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiGet, apiPatch, apiPost } from "../../shared/api";
import { errorMessage } from "./errors";
import { ROLE_LABELS, type Role } from "../../shared/auth";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  useToast,
  type BadgeTone,
} from "../../shared/ui";

type AccountUser = {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  status: "invited" | "active" | "suspended";
  has_password: boolean;
};

const STATUS: Record<AccountUser["status"], { label: string; tone: BadgeTone }> = {
  invited: { label: "Invitado", tone: "info" },
  active: { label: "Activo", tone: "success" },
  suspended: { label: "Suspendido", tone: "danger" },
};

function message(err: unknown, fallback: string): string {
  return errorMessage(err, "users", fallback);
}

/** Minimal user management for the secretary: list, invite professors/secretaries, suspend. */
export function UsersPage() {
  const toast = useToast();
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<AccountUser | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await apiGet<AccountUser[]>("/users"));
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err, "No se pudieron cargar los usuarios."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reissue = async (u: AccountUser) => {
    try {
      const res = await apiPost<{ invite_url: string }>(`/users/${u.id}/invite`, {});
      setInviteUrl(res.invite_url);
      toast.show({ message: "Invitación reenviada.", tone: "success" });
    } catch (err) {
      toast.show({ message: message(err, "No se pudo reenviar la invitación."), tone: "error" });
    }
  };

  return (
    <>
      <PageHeader
        title="Usuarios"
        subtitle="Docentes, estudiantes y personal de Secretaría."
        actions={<Button onClick={() => setCreating(true)}>Invitar usuario</Button>}
      />
      {inviteUrl && (
        <Card title="Enlace de invitación">
          <p style={{ marginTop: 0 }}>
            Enviá este enlace a la persona; sirve una sola vez para crear su contraseña.
          </p>
          <Input label="Enlace" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
        </Card>
      )}
      {loadError && (
        <p className="au-field__error" role="alert">
          {loadError}
        </p>
      )}
      {!users && !loadError && <Spinner />}
      {users && users.length === 0 && <EmptyState title="Todavía no hay usuarios" />}
      {users && users.length > 0 && (
        <Table caption="Usuarios">
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
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.full_name}</td>
                <td>{u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>
                  <Badge tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Badge>
                </td>
                <td>
                  {!u.has_password && u.status !== "suspended" && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => void reissue(u)}>
                        Reenviar invitación
                      </Button>{" "}
                    </>
                  )}
                  <Button
                    size="sm"
                    variant={u.status === "suspended" ? "secondary" : "danger"}
                    onClick={() => setTarget(u)}
                  >
                    {u.status === "suspended" ? "Reactivar" : "Suspender"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(url) => {
          setCreating(false);
          setInviteUrl(url);
          toast.show({ message: "Usuario creado.", tone: "success" });
          void load();
        }}
      />
      <StatusModal
        user={target}
        onClose={() => setTarget(null)}
        onDone={() => {
          setTarget(null);
          toast.show({ message: "Estado actualizado.", tone: "success" });
          void load();
        }}
      />
    </>
  );
}

function CreateUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (inviteUrl: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("professor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiPost<{ invite_url: string }>("/users", {
        email: email.trim(),
        full_name: fullName.trim(),
        role,
      });
      setFullName("");
      setEmail("");
      onCreated(res.invite_url);
    } catch (err) {
      setError(message(err, "No se pudo crear el usuario."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Invitar usuario"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="create-user-form" loading={busy}>
            Crear
          </Button>
        </>
      }
    >
      <form id="create-user-form" className="au-stack" onSubmit={submit} noValidate>
        <Input
          label="Nombre completo"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
        <Input
          label="Correo electrónico"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select
          label="Rol"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          options={[
            { value: "professor", label: ROLE_LABELS.professor },
            { value: "secretary", label: ROLE_LABELS.secretary },
          ]}
        />
        {error && (
          <p className="au-field__error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function StatusModal({
  user,
  onClose,
  onDone,
}: {
  user: AccountUser | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suspending = user?.status !== "suspended";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError(null);
    setBusy(true);
    try {
      await apiPatch(`/users/${user.id}`, {
        status: suspending ? "suspended" : "active",
        reason: reason.trim(),
      });
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
      open={user !== null}
      title={suspending ? "Suspender cuenta" : "Reactivar cuenta"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="status-form"
            variant={suspending ? "danger" : "primary"}
            loading={busy}
            disabled={!reason.trim()}
          >
            Confirmar
          </Button>
        </>
      }
    >
      <form id="status-form" className="au-stack" onSubmit={submit} noValidate>
        <p style={{ margin: 0 }}>
          {user?.full_name} ({user?.email}). El cambio queda registrado con tu nombre y el motivo.
        </p>
        <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
        {error && (
          <p className="au-field__error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
