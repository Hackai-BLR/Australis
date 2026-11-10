import { HealthStatus } from "../modules/health";

export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Australis</h1>
      <HealthStatus />
    </main>
  );
}
