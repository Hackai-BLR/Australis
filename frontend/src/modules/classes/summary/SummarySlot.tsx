import type { ClassItem } from "../api";

/** Seam for F11: replace the body with the class summary panel. Mounted on the class page. */
export function SummarySlot({ classItem }: { classItem: ClassItem }) {
  return <div data-slot="class-summary" data-class-id={classItem.id} hidden />;
}
