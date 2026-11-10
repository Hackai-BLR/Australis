// Small presentational primitives. Styles live in ui.css; colours and spacing in tokens.css.
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TableHTMLAttributes,
} from "react";

function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "sm";
  /** Shows a spinner, disables the button and announces the busy state. */
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, className, disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cx("au-btn", `au-btn--${variant}`, size === "sm" && "au-btn--sm", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="au-spinner__circle" aria-hidden="true" />}
      {children}
    </button>
  );
});

type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
};

function Field({
  id,
  label,
  hint,
  error,
  children,
}: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="au-field">
      <label className="au-field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && !error && (
        <span className="au-field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="au-field__error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string) {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldProps;

/** A labelled text input with optional hint and error text. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Field id={inputId} label={label} hint={hint} error={error}>
      <input
        ref={ref}
        id={inputId}
        className={cx("au-input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        {...rest}
      />
    </Field>
  );
});

export type SelectOption = { value: string; label: string };

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> &
  FieldProps & { options?: SelectOption[] };

/** A labelled native select. Pass `options` or <option> children. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, options, children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <Field id={selectId} label={label} hint={hint} error={error}>
      <select
        ref={ref}
        id={selectId}
        className={cx("au-select", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(selectId, hint, error)}
        {...rest}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
    </Field>
  );
});

export function Card({
  title,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cx("au-card", className)}>
      {(title || actions) && (
        <header className="au-card__header">
          {title && <h2 className="au-card__title">{title}</h2>}
          {actions && <div className="au-row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A styled, horizontally scrollable table. Write <thead>/<tbody> as children. */
export function Table({
  caption,
  className,
  children,
  ...rest
}: TableHTMLAttributes<HTMLTableElement> & { caption?: ReactNode }) {
  return (
    <div className="au-table-wrap">
      <table className={cx("au-table", className)} {...rest}>
        {caption && <caption>{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "simulated";

export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("au-badge", tone !== "neutral" && `au-badge--${tone}`)} title={title}>
      {children}
    </span>
  );
}

/**
 * Marks data that comes from a placeholder provider (scripted AI, fake Zoom meeting, sample
 * recording). Show it wherever such data appears.
 */
export function SimulatedBadge({ detail }: { detail?: string }) {
  return (
    <Badge tone="simulated" title={detail ?? "Datos de ejemplo: no provienen de un servicio real."}>
      Simulado
    </Badge>
  );
}

export function Spinner({ label = "Cargando…" }: { label?: string }) {
  return (
    <span className="au-spinner" role="status">
      <span className="au-spinner__circle" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="au-empty">
      <h2 className="au-empty__title">{title}</h2>
      {description && <p style={{ margin: 0 }}>{description}</p>}
      {action && <div className="au-empty__action">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** E.g. <SimulatedBadge /> next to the title. */
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="au-page-header">
      <div>
        <h1 className="au-page-header__title">
          {title}
          {badge}
        </h1>
        {subtitle && <p className="au-page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="au-row">{actions}</div>}
    </header>
  );
}
