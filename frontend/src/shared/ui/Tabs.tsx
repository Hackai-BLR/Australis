import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type TabItem = { id: string; label: ReactNode; disabled?: boolean };

/**
 * Accessible in-page tabs (WAI-ARIA tabs pattern, arrow keys move between tabs). For tabs that
 * change the URL, use router links with the "au-tabs" / "au-tab" classes instead.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  children,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Content of the selected tab. */
  children?: ReactNode;
}) {
  const baseId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = items.filter((i) => !i.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = enabled.findIndex((i) => i.id === value);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % enabled.length;
    if (e.key === "ArrowLeft") next = (index - 1 + enabled.length) % enabled.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = enabled.length - 1;
    if (next === null || enabled.length === 0) return;
    e.preventDefault();
    const id = enabled[next].id;
    onChange(id);
    refs.current[id]?.focus();
  };

  return (
    <div>
      <div className="au-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[item.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className="au-tab"
              onClick={() => onChange(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        className="au-tabpanel"
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${value}`}
      >
        {children}
      </div>
    </div>
  );
}
