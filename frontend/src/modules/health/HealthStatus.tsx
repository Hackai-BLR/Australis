import { useEffect, useState } from "react";
import { getHealth, type Health } from "./api";

export function HealthStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p>Backend: error ({error})</p>;
  if (!health) return <p>Backend: checking…</p>;
  return (
    <p>
      Backend: {health.status} · Database: {health.database}
    </p>
  );
}
