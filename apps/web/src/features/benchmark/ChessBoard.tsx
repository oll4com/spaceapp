const GLYPHS: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const FILES = "abcdefgh";
// Text presentation selector: without it some platforms draw the pawn as an emoji.
const TEXT_STYLE = "\uFE0E";

/** Piece placement from a FEN: 64 entries, index = rank * 8 + file (a1 = 0). */
export function boardFromFen(fen: string): string[] {
  const rows = fen.trim().split(/\s+/)[0]?.split("/") ?? [];
  const board: string[] = new Array(64).fill("");
  if (rows.length !== 8) return board;
  rows.forEach((row, index) => {
    const rank = 7 - index;
    let file = 0;
    for (const char of row) {
      if (/[1-8]/.test(char)) file += Number(char);
      else if (/[pnbrqkPNBRQK]/.test(char) && file < 8) board[rank * 8 + file++] = char;
    }
  });
  return board;
}

function squareIndex(name: string): number | null {
  if (!/^[a-h][1-8]$/.test(name)) return null;
  return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]!);
}

export function ChessBoard({
  fen,
  lastMove,
  label,
  coordinates = false,
}: {
  fen: string;
  lastMove?: string | null;
  label: string;
  coordinates?: boolean;
}) {
  const board = boardFromFen(fen);
  const from = lastMove ? squareIndex(lastMove.slice(0, 2)) : null;
  const to = lastMove ? squareIndex(lastMove.slice(2, 4)) : null;
  const squares = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    for (let file = 0; file < 8; file += 1) {
      const index = rank * 8 + file;
      const piece = board[index];
      const shade = (file + rank) % 2 === 1 ? "light" : "dark";
      const highlighted = index === from || index === to;
      squares.push(
        <span key={index} className={`chess-square ${shade}${highlighted ? " last" : ""}`}>
          {piece ? (
            <span className={`chess-piece ${piece === piece.toUpperCase() ? "white" : "black"}`}>
              {GLYPHS[piece.toLowerCase()]}
              {TEXT_STYLE}
            </span>
          ) : null}
          {coordinates && file === 0 ? <span className="chess-coord rank">{rank + 1}</span> : null}
          {coordinates && rank === 0 ? <span className="chess-coord file">{FILES[file]}</span> : null}
        </span>
      );
    }
  }
  return (
    <div className="chess-board" role="img" aria-label={label}>
      {squares}
    </div>
  );
}
