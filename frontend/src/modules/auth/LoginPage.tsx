import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../../shared/api";
import { useAuth } from "../../shared/auth";
import { Button, Card, Input, Spinner } from "../../shared/ui";

/** Only same-site paths are accepted as a return target. */
function safeNext(next: string | null): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

/** Minimal sign-in page (email and password). The auth package completes it. */
export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "loading") {
    return (
      <div className="au-page-center">
        <Spinner />
      </div>
    );
  }
  if (status === "authenticated") return <Navigate to={next} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión.");
      setBusy(false);
    }
  };

  return (
    <div className="au-page-center">
      <div style={{ width: "min(24rem, 100%)" }}>
        <h1 className="au-brand" style={{ textAlign: "center", marginBottom: "var(--space-5)" }}>
          Australis
        </h1>
        <Card title="Iniciar sesión">
          <form className="au-stack" onSubmit={onSubmit} noValidate>
            <Input
              label="Correo electrónico"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Contraseña"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && (
              <p className="au-field__error" role="alert" style={{ margin: 0 }}>
                {error}
              </p>
            )}
            <Button type="submit" loading={busy} disabled={!email || !password}>
              Ingresar
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
