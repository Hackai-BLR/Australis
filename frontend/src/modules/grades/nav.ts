// Keyboard navigation of the grade grid, as a pure function.

export type Cell = { row: number; col: number };

/**
 * Where focus goes after a key, or null when the key is not a navigation key here (or Tab has
 * nowhere to go, so the browser may leave the grid).
 *
 * Arrows move one cell and stop at the edges. Enter moves down and, at the bottom, to the top
 * of the next column (so a whole column can be typed in one go); Shift+Enter goes back. Tab
 * moves right and wraps to the next row; Shift+Tab goes back.
 */
export function moveCell(
  cell: Cell,
  key: string,
  shift: boolean,
  rows: number,
  cols: number,
): Cell | null {
  if (rows === 0 || cols === 0) return null;
  const clampRow = (r: number) => Math.min(Math.max(r, 0), rows - 1);
  const clampCol = (c: number) => Math.min(Math.max(c, 0), cols - 1);
  switch (key) {
    case "ArrowUp":
      return { row: clampRow(cell.row - 1), col: cell.col };
    case "ArrowDown":
      return { row: clampRow(cell.row + 1), col: cell.col };
    case "ArrowLeft":
      return { row: cell.row, col: clampCol(cell.col - 1) };
    case "ArrowRight":
      return { row: cell.row, col: clampCol(cell.col + 1) };
    case "Enter":
      if (!shift) {
        if (cell.row < rows - 1) return { row: cell.row + 1, col: cell.col };
        if (cell.col < cols - 1) return { row: 0, col: cell.col + 1 };
        return cell;
      }
      if (cell.row > 0) return { row: cell.row - 1, col: cell.col };
      if (cell.col > 0) return { row: rows - 1, col: cell.col - 1 };
      return cell;
    case "Tab":
      if (!shift) {
        if (cell.col < cols - 1) return { row: cell.row, col: cell.col + 1 };
        if (cell.row < rows - 1) return { row: cell.row + 1, col: 0 };
        return null;
      }
      if (cell.col > 0) return { row: cell.row, col: cell.col - 1 };
      if (cell.row > 0) return { row: cell.row - 1, col: cols - 1 };
      return null;
    default:
      return null;
  }
}
