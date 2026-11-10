import { useMemo, useState } from "react";
import { Input } from "../../../shared/ui";
import { splitMatches } from "./api";

/** The transcript with in-page search: matches are highlighted and counted. */
export function TranscriptViewer({ text }: { text: string }) {
  const [query, setQuery] = useState("");
  const lines = useMemo(() => text.split("\n").filter((line) => line.trim() !== ""), [text]);
  const total = useMemo(() => {
    if (!query.trim()) return 0;
    return lines.reduce(
      (sum, line) => sum + splitMatches(line, query).filter((part) => part.match).length,
      0,
    );
  }, [lines, query]);

  return (
    <div className="au-stack">
      <Input
        label="Buscar en la transcripción"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() && (
        <p role="status">{total === 1 ? "1 coincidencia" : `${total} coincidencias`}</p>
      )}
      <div
        style={{ maxHeight: "24rem", overflowY: "auto" }}
        tabIndex={0}
        aria-label="Transcripción"
      >
        {lines.map((line, i) => (
          <p key={i} style={{ margin: "0 0 0.5rem" }}>
            {splitMatches(line, query).map((part, j) =>
              part.match ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>,
            )}
          </p>
        ))}
      </div>
    </div>
  );
}
