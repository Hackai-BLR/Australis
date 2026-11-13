/**
 * Seam for F15: replace the body with the student's private notes for the page they are on.
 * Mounted under the presentation a student follows.
 */
export function NotesSlot({
  campusId,
  presentationId,
  page,
}: {
  campusId: string;
  presentationId: number;
  page: number;
}) {
  return (
    <div
      data-slot="slide-notes"
      data-campus-id={campusId}
      data-presentation-id={presentationId}
      data-page={page}
      hidden
    />
  );
}
