import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../shared/api";
import { ROLE_LABELS, useAuth, type Role } from "../../shared/auth";
import { Button, Card, Input, Spinner } from "../../shared/ui";
import { errorMessage } from "./errors";

type InviteInfo = { email: string; full_name: string; role: Role };

const MIN_PASSWORD = 8;

/** Public page where an invited person chooses their password (once). */
export function InvitePage() {
  const { token = "" } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<InviteInfo>(`/auth/invites/${encodeURIComponent(token)}`, { skipAuthRedirect: true })
      .then((info) => {
        if (cancelled) return;
        setInvite(info);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    try {
      await apiPost(
        `/auth/invites/${encodeURIComponent(token)}/accept`,
        { password },
        {
          skipAuthRedirect: true,
        },
      );
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err, "invite", "No se pudo guardar la contraseña."));
      setBusy(false);
    }
  };

  return (
    <div className="au-page-center">
      <div style={{ width: "min(24rem, 100%)" }}>
        <h1 className="au-brand" style={{ textAlign: "center", marginBottom: "var(--space-5)" }}>
          Australis
        </h1>
        {state === "loading" && <Spinner />}
        {state === "invalid" && (
          <Card title="Invitación no válida">
            <p style={{ margin: 0 }}>
              Este enlace ya se usó, venció o no existe. Pedile a Secretaría que te envíe una nueva
              invitación.
            </p>
          </Card>
        )}
        {state === "ready" && invite && (
          <Card title="Creá tu contraseña">
            <form className="au-stack" onSubmit={onSubmit} noValidate>
              <p style={{ margin: 0 }}>
                Hola, {invite.full_name} ({ROLE_LABELS[invite.role]}). Tu cuenta es{" "}
                <strong>{invite.email}</strong>.
              </p>
              <Input
                label="Contraseña"
                type="password"
                autoComplete="new-password"
                hint={`Al menos ${MIN_PASSWORD} caracteres.`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Input
                label="Repetir contraseña"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {error && (
                <p className="au-field__error" role="alert" style={{ margin: 0 }}>
                  {error}
                </p>
              )}
              <Button type="submit" loading={busy} disabled={!password || !confirm}>
                Guardar y entrar
              </Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
