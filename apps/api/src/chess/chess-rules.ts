/**
 * Chess rules for the Benchmark chess tournament.
 *
 * Board: 64 entries, index = rank * 8 + file (a1 = 0, h8 = 63), "" = empty,
 * uppercase = White, lowercase = Black. Positions are immutable: makeMove
 * returns a new position. Move generation is verified with perft
 * (apps/api/src/__tests__/chess-rules.test.ts).
 */

export type ChessColor = "w" | "b";
export type ChessPromotion = "n" | "b" | "r" | "q";

export interface ChessPosition {
  board: string[];
  turn: ChessColor;
  /** Subset of "KQkq" in that order; "" when nobody can castle. */
  castling: string;
  /** En passant target square, or null. */
  ep: number | null;
  halfmove: number;
  fullmove: number;
}

export interface ChessMove {
  from: number;
  to: number;
  piece: string;
  captured?: string;
  promotion?: ChessPromotion;
  castle?: "K" | "Q";
  enPassant?: boolean;
}

export type ChessResult = "1-0" | "0-1" | "1/2-1/2";
export type ChessEndReason =
  | "checkmate"
  | "stalemate"
  | "threefold"
  | "fifty_move"
  | "insufficient_material";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FILES = "abcdefgh";
const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const BISHOP_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const PROMOTIONS: readonly ChessPromotion[] = ["q", "r", "b", "n"];
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function colorOf(piece: string): ChessColor {
  return piece === piece.toUpperCase() ? "w" : "b";
}

function opposite(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}

function own(piece: string, color: ChessColor): string {
  return color === "w" ? piece.toUpperCase() : piece.toLowerCase();
}

function squareAt(file: number, rank: number): number | null {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8 ? rank * 8 + file : null;
}

export function squareName(square: number): string {
  return `${FILES[square & 7]}${(square >> 3) + 1}`;
}

export function parseSquare(name: string): number | null {
  if (!/^[a-h][1-8]$/.test(name)) return null;
  return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]!);
}

export function parseFen(fen: string): ChessPosition {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error("FEN needs at least four fields.");
  const rows = parts[0]!.split("/");
  if (rows.length !== 8) throw new Error("FEN board needs eight ranks.");
  const board: string[] = new Array(64).fill("");
  rows.forEach((row, index) => {
    const rank = 7 - index;
    let file = 0;
    for (const char of row) {
      if (/[1-8]/.test(char)) file += Number(char);
      else if (/[pnbrqkPNBRQK]/.test(char) && file < 8) board[rank * 8 + file++] = char;
      else throw new Error("Invalid FEN board.");
    }
    if (file !== 8) throw new Error("Invalid FEN rank length.");
  });
  if (board.filter((piece) => piece === "K").length !== 1 || board.filter((piece) => piece === "k").length !== 1) {
    throw new Error("FEN needs exactly one king per side.");
  }
  const turn = parts[1];
  if (turn !== "w" && turn !== "b") throw new Error("Invalid FEN side to move.");
  const rights = parts[2]!;
  if (rights !== "-" && !/^[KQkq]{1,4}$/.test(rights)) throw new Error("Invalid FEN castling field.");
  const ep = parts[3] === "-" ? null : parseSquare(parts[3]!);
  if (parts[3] !== "-" && ep === null) throw new Error("Invalid FEN en passant field.");
  const halfmove = Number.parseInt(parts[4] ?? "0", 10);
  const fullmove = Number.parseInt(parts[5] ?? "1", 10);
  return {
    board,
    turn,
    castling: [..."KQkq"].filter((right) => rights.includes(right)).join(""),
    ep,
    halfmove: Number.isFinite(halfmove) && halfmove >= 0 ? halfmove : 0,
    fullmove: Number.isFinite(fullmove) && fullmove >= 1 ? fullmove : 1,
  };
}

export function toFen(position: ChessPosition): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = position.board[rank * 8 + file];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) row += String(empty);
      empty = 0;
      row += piece;
    }
    rows.push(empty ? row + String(empty) : row);
  }
  return [
    rows.join("/"),
    position.turn,
    position.castling || "-",
    position.ep === null ? "-" : squareName(position.ep),
    String(position.halfmove),
    String(position.fullmove),
  ].join(" ");
}

export function isSquareAttacked(board: readonly string[], square: number, by: ChessColor): boolean {
  const file = square & 7;
  const rank = square >> 3;
  // A White pawn attacks upwards, so its attackers sit one rank below.
  const pawnRank = by === "w" ? rank - 1 : rank + 1;
  for (const df of [-1, 1]) {
    const from = squareAt(file + df, pawnRank);
    if (from !== null && board[from] === own("p", by)) return true;
  }
  for (const [df, dr] of KNIGHT_STEPS) {
    const from = squareAt(file + df, rank + dr);
    if (from !== null && board[from] === own("n", by)) return true;
  }
  for (const [df, dr] of KING_STEPS) {
    const from = squareAt(file + df, rank + dr);
    if (from !== null && board[from] === own("k", by)) return true;
  }
  const slides = (dirs: typeof BISHOP_DIRS, pieces: string[]) => {
    for (const [df, dr] of dirs) {
      for (let step = 1; step < 8; step += 1) {
        const from = squareAt(file + df * step, rank + dr * step);
        if (from === null) break;
        const piece = board[from];
        if (!piece) continue;
        if (pieces.includes(piece)) return true;
        break;
      }
    }
    return false;
  };
  return slides(BISHOP_DIRS, [own("b", by), own("q", by)]) || slides(ROOK_DIRS, [own("r", by), own("q", by)]);
}

export function isInCheck(position: ChessPosition, color: ChessColor = position.turn): boolean {
  const king = position.board.indexOf(own("k", color));
  return king >= 0 && isSquareAttacked(position.board, king, opposite(color));
}

function pseudoLegalMoves(position: ChessPosition): ChessMove[] {
  const { board, turn } = position;
  const moves: ChessMove[] = [];
  const enemy = opposite(turn);
  const addPawnMove = (move: ChessMove) => {
    const toRank = move.to >> 3;
    if (toRank === 0 || toRank === 7) {
      for (const promotion of PROMOTIONS) moves.push({ ...move, promotion });
    } else {
      moves.push(move);
    }
  };

  for (let from = 0; from < 64; from += 1) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== turn) continue;
    const file = from & 7;
    const rank = from >> 3;
    const type = piece.toLowerCase();

    if (type === "p") {
      const dir = turn === "w" ? 1 : -1;
      const one = squareAt(file, rank + dir);
      if (one !== null && !board[one]) {
        addPawnMove({ from, to: one, piece });
        const startRank = turn === "w" ? 1 : 6;
        const two = squareAt(file, rank + 2 * dir);
        if (rank === startRank && two !== null && !board[two]) moves.push({ from, to: two, piece });
      }
      for (const df of [-1, 1]) {
        const to = squareAt(file + df, rank + dir);
        if (to === null) continue;
        const target = board[to];
        if (target && colorOf(target) === enemy) addPawnMove({ from, to, piece, captured: target });
        else if (!target && to === position.ep) moves.push({ from, to, piece, captured: own("p", enemy), enPassant: true });
      }
      continue;
    }

    const steps = type === "n" ? KNIGHT_STEPS : type === "k" ? KING_STEPS : null;
    if (steps) {
      for (const [df, dr] of steps) {
        const to = squareAt(file + df, rank + dr);
        if (to === null) continue;
        const target = board[to];
        if (!target) moves.push({ from, to, piece });
        else if (colorOf(target) === enemy) moves.push({ from, to, piece, captured: target });
      }
    } else {
      const dirs = type === "b" ? BISHOP_DIRS : type === "r" ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
      for (const [df, dr] of dirs) {
        for (let step = 1; step < 8; step += 1) {
          const to = squareAt(file + df * step, rank + dr * step);
          if (to === null) break;
          const target = board[to];
          if (!target) {
            moves.push({ from, to, piece });
            continue;
          }
          if (colorOf(target) === enemy) moves.push({ from, to, piece, captured: target });
          break;
        }
      }
    }

    if (type === "k") {
      const home = turn === "w" ? 4 : 60;
      const kingSide = turn === "w" ? "K" : "k";
      const queenSide = turn === "w" ? "Q" : "q";
      if (from === home && !isSquareAttacked(board, home, enemy)) {
        if (
          position.castling.includes(kingSide) &&
          !board[home + 1] && !board[home + 2] &&
          board[home + 3] === own("r", turn) &&
          !isSquareAttacked(board, home + 1, enemy) && !isSquareAttacked(board, home + 2, enemy)
        ) {
          moves.push({ from, to: home + 2, piece, castle: "K" });
        }
        if (
          position.castling.includes(queenSide) &&
          !board[home - 1] && !board[home - 2] && !board[home - 3] &&
          board[home - 4] === own("r", turn) &&
          !isSquareAttacked(board, home - 1, enemy) && !isSquareAttacked(board, home - 2, enemy)
        ) {
          moves.push({ from, to: home - 2, piece, castle: "Q" });
        }
      }
    }
  }
  return moves;
}

const CORNER_RIGHTS: Record<number, string> = { 0: "Q", 7: "K", 56: "q", 63: "k" };

export function makeMove(position: ChessPosition, move: ChessMove): ChessPosition {
  const board = position.board.slice();
  const piece = board[move.from]!;
  const turn = position.turn;
  const dir = turn === "w" ? 1 : -1;
  board[move.from] = "";
  if (move.enPassant) board[move.to - 8 * dir] = "";
  board[move.to] = move.promotion ? own(move.promotion, turn) : piece;
  if (move.castle === "K") {
    board[move.from + 1] = board[move.from + 3]!;
    board[move.from + 3] = "";
  } else if (move.castle === "Q") {
    board[move.from - 1] = board[move.from - 4]!;
    board[move.from - 4] = "";
  }

  let castling = position.castling;
  if (piece === "K") castling = castling.replace(/[KQ]/g, "");
  if (piece === "k") castling = castling.replace(/[kq]/g, "");
  for (const square of [move.from, move.to]) {
    const right = CORNER_RIGHTS[square];
    if (right) castling = castling.replace(right, "");
  }

  const isPawn = piece.toLowerCase() === "p";
  return {
    board,
    turn: opposite(turn),
    castling,
    ep: isPawn && Math.abs(move.to - move.from) === 16 ? move.from + 8 * dir : null,
    halfmove: isPawn || move.captured ? 0 : position.halfmove + 1,
    fullmove: turn === "b" ? position.fullmove + 1 : position.fullmove,
  };
}

export function legalMoves(position: ChessPosition): ChessMove[] {
  return pseudoLegalMoves(position).filter((move) => !isInCheck(makeMove(position, move), position.turn));
}

export function moveToUci(move: ChessMove): string {
  return `${squareName(move.from)}${squareName(move.to)}${move.promotion ?? ""}`;
}

export function moveToSan(position: ChessPosition, move: ChessMove, legal: ChessMove[] = legalMoves(position)): string {
  let san: string;
  if (move.castle) {
    san = move.castle === "K" ? "O-O" : "O-O-O";
  } else {
    const type = move.piece.toLowerCase();
    const target = squareName(move.to);
    if (type === "p") {
      san = move.captured ? `${FILES[move.from & 7]}x${target}` : target;
      if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
    } else {
      const rivals = legal.filter((other) => other.piece === move.piece && other.to === move.to && other.from !== move.from);
      let disambiguation = "";
      if (rivals.length > 0) {
        const sameFile = rivals.some((other) => (other.from & 7) === (move.from & 7));
        const sameRank = rivals.some((other) => other.from >> 3 === move.from >> 3);
        if (!sameFile) disambiguation = FILES[move.from & 7]!;
        else if (!sameRank) disambiguation = String((move.from >> 3) + 1);
        else disambiguation = squareName(move.from);
      }
      san = `${type.toUpperCase()}${disambiguation}${move.captured ? "x" : ""}${target}`;
    }
  }
  const next = makeMove(position, move);
  if (isInCheck(next)) san += legalMoves(next).length === 0 ? "#" : "+";
  return san;
}

/** Repetition identity: board, side, castling rights and a usable en passant square. */
export function positionKey(position: ChessPosition): string {
  const fields = toFen(position).split(" ");
  const epUsable =
    position.ep !== null && pseudoLegalMoves(position).some((move) => move.enPassant);
  return `${fields[0]} ${fields[1]} ${fields[2]} ${epUsable ? fields[3] : "-"}`;
}

export function hasInsufficientMaterial(position: ChessPosition): boolean {
  const pieces: Array<{ type: string; square: number }> = [];
  position.board.forEach((piece, square) => {
    if (piece && piece.toLowerCase() !== "k") pieces.push({ type: piece.toLowerCase(), square });
  });
  if (pieces.length === 0) return true;
  if (pieces.some((piece) => piece.type === "p" || piece.type === "r" || piece.type === "q")) return false;
  if (pieces.length === 1) return true;
  // Only bishops left, all on squares of one colour.
  if (pieces.every((piece) => piece.type === "b")) {
    const shade = (square: number) => ((square & 7) + (square >> 3)) % 2;
    return pieces.every((piece) => shade(piece.square) === shade(pieces[0]!.square));
  }
  return false;
}

/** Material from White's point of view (pawn = 1, knight/bishop = 3, rook = 5, queen = 9). */
export function materialBalance(position: ChessPosition): number {
  return position.board.reduce((sum, piece) => {
    if (!piece) return sum;
    const value = PIECE_VALUES[piece.toLowerCase()] ?? 0;
    return sum + (colorOf(piece) === "w" ? value : -value);
  }, 0);
}

export interface ChessOutcome {
  result: ChessResult;
  reason: ChessEndReason;
}

/** Game end by the rules, given how often the current position has occurred. */
export function gameOutcome(
  position: ChessPosition,
  repetitions: number,
  legal: ChessMove[] = legalMoves(position)
): ChessOutcome | null {
  if (legal.length === 0) {
    if (isInCheck(position)) return { result: position.turn === "w" ? "0-1" : "1-0", reason: "checkmate" };
    return { result: "1/2-1/2", reason: "stalemate" };
  }
  if (hasInsufficientMaterial(position)) return { result: "1/2-1/2", reason: "insufficient_material" };
  if (repetitions >= 3) return { result: "1/2-1/2", reason: "threefold" };
  if (position.halfmove >= 100) return { result: "1/2-1/2", reason: "fifty_move" };
  return null;
}

const UCI_PATTERN = /\b([a-h][1-8])-?([a-h][1-8])(?:=?([qrbnQRBN]))?\b/g;

function stripSan(value: string): string {
  return value.replace(/[+#!?]+$/g, "").replace(/0/g, "O").replace(/=/g, "");
}

/**
 * Reads a move from a model answer: the JSON "move" field first, then any
 * UCI or SAN token that is legal in this position. Model text is untrusted
 * and only ever matched against the legal move list.
 */
export function findMoveInText(position: ChessPosition, text: string, legal: ChessMove[] = legalMoves(position)): ChessMove | null {
  const candidates: string[] = [];
  const jsonMatch = text.match(/"move"\s*:\s*"([^"]{1,16})"/i);
  if (jsonMatch?.[1]) candidates.push(jsonMatch[1].trim());
  const bareText = text.trim();
  if (bareText.length <= 16) candidates.push(bareText);

  const byUci = (from: string, to: string, promotion?: string) => {
    const matches = legal.filter((move) => squareName(move.from) === from && squareName(move.to) === to);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0]!;
    return matches.find((move) => move.promotion === (promotion?.toLowerCase() ?? "q")) ?? null;
  };
  const sanMap = new Map(legal.map((move) => [stripSan(moveToSan(position, move, legal)), move]));

  const resolve = (token: string): ChessMove | null => {
    const uci = token.match(/^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/);
    if (uci) return byUci(uci[1]!, uci[2]!, uci[3]);
    return sanMap.get(stripSan(token)) ?? null;
  };

  for (const candidate of candidates) {
    const move = resolve(candidate);
    if (move) return move;
  }
  for (const match of text.matchAll(UCI_PATTERN)) {
    const move = byUci(match[1]!, match[2]!, match[3]);
    if (move) return move;
  }
  return null;
}

export function perft(position: ChessPosition, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(position);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) nodes += perft(makeMove(position, move), depth - 1);
  return nodes;
}
