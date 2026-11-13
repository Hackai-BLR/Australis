/** The campus the current page belongs to, from /campuses/:id/... (null elsewhere). */
export function campusIdOf(pathname: string): number | null {
  const match = /^\/campuses\/(\d+)(\/|$)/.exec(pathname);
  return match ? Number(match[1]) : null;
}
