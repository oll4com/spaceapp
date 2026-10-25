import { describe, expect, it } from "vitest";
import {
  START_FEN,
  findMoveInText,
  gameOutcome,
  hasInsufficientMaterial,
  legalMoves,
  makeMove,
  materialBalance,
  moveToSan,
  moveToUci,
  parseFen,
  perft,
  positionKey,
  toFen,
} from "../chess/chess-rules.js";

function play(fen: string, uciMoves: string[]) {
  let position = parseFen(fen);
  for (const uci of uciMoves) {
    const move = legalMoves(position).find((candidate) => moveToUci(candidate) === uci);
    if (!move) throw new Error(`Illegal test move ${uci} in ${toFen(position)}`);
    position = makeMove(position, move);
  }
  return position;
}

describe("chess rules perft", () => {
  // Reference node counts: https://www.chessprogramming.org/Perft_Results
  it.each([
    ["start position", START_FEN, [20, 400, 8902]],
    ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
    ["position 3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
    ["position 4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
    ["position 5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
  ])("matches reference counts for %s", (_name, fen, counts) => {
    const position = parseFen(fen as string);
    (counts as number[]).forEach((expected, index) => {
      expect(perft(position, index + 1)).toBe(expected);
    });
  }, 60_000);
});

describe("chess rules", () => {
  it("round-trips FEN", () => {
    const fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
    expect(toFen(parseFen(fen))).toBe(fen);
    expect(toFen(play(START_FEN, ["e2e4"]))).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
  });

  it("rejects malformed FEN", () => {
    expect(() => parseFen("8/8/8/8/8/8/8/8 w - - 0 1")).toThrow();
    expect(() => parseFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1")).toThrow();
  });

  it("detects checkmate and stalemate", () => {
    const mate = play(START_FEN, ["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(gameOutcome(mate, 1)).toEqual({ result: "0-1", reason: "checkmate" });
    const stalemate = parseFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    expect(gameOutcome(stalemate, 1)).toEqual({ result: "1/2-1/2", reason: "stalemate" });
  });

  it("detects draws by material, fifty moves and repetition", () => {
    expect(hasInsufficientMaterial(parseFen("8/8/4k3/8/8/2B5/4K3/8 w - - 0 1"))).toBe(true);
    expect(hasInsufficientMaterial(parseFen("8/8/4k3/8/8/2N5/4K3/8 w - - 0 1"))).toBe(true);
    expect(hasInsufficientMaterial(parseFen("8/8/4k3/8/8/2R5/4K3/8 w - - 0 1"))).toBe(false);
    expect(gameOutcome(parseFen("8/8/4k3/8/8/2R5/4K3/8 w - - 100 80"), 1)?.reason).toBe("fifty_move");
    expect(gameOutcome(parseFen(START_FEN), 3)?.reason).toBe("threefold");

    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    const start = parseFen(START_FEN);
    const back = play(START_FEN, shuffle);
    expect(positionKey(back)).toBe(positionKey(start));
  });

  it("ignores an en passant square nobody can use in the repetition key", () => {
    const afterDouble = play(START_FEN, ["e2e4"]);
    expect(positionKey(afterDouble).endsWith(" -")).toBe(true);
    const usable = play(START_FEN, ["e2e4", "a7a6", "e4e5", "d7d5"]);
    expect(positionKey(usable).endsWith(" d6")).toBe(true);
  });

  it("writes SAN with disambiguation, castling, promotion and check marks", () => {
    const knights = parseFen("4k3/8/8/8/8/8/8/N1N1K3 w - - 0 1");
    const nb3 = legalMoves(knights).find((move) => moveToUci(move) === "a1b3")!;
    expect(moveToSan(knights, nb3)).toBe("Nab3");

    const castle = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const shortCastle = legalMoves(castle).find((move) => moveToUci(move) === "e1g1")!;
    expect(moveToSan(castle, shortCastle)).toBe("O-O");

    const promotion = parseFen("8/P6k/8/8/8/8/8/K7 w - - 0 1");
    const queen = legalMoves(promotion).find((move) => moveToUci(move) === "a7a8q")!;
    expect(moveToSan(promotion, queen)).toBe("a8=Q");

    const mate = play(START_FEN, ["f2f3", "e7e5", "g2g4"]);
    const qh4 = legalMoves(mate).find((move) => moveToUci(move) === "d8h4")!;
    expect(moveToSan(mate, qh4)).toBe("Qh4#");
  });

  it("finds moves in model answers and refuses illegal ones", () => {
    const position = parseFen(START_FEN);
    expect(moveToUci(findMoveInText(position, '{"move":"e2e4"}')!)).toBe("e2e4");
    expect(moveToUci(findMoveInText(position, '{"move": "Nf3"}')!)).toBe("g1f3");
    expect(moveToUci(findMoveInText(position, "I will play d2-d4 here.")!)).toBe("d2d4");
    expect(findMoveInText(position, '{"move":"e2e5"}')).toBeNull();
    expect(findMoveInText(position, "resign")).toBeNull();

    const promotion = parseFen("8/P6k/8/8/8/8/8/K7 w - - 0 1");
    expect(moveToUci(findMoveInText(promotion, '{"move":"a7a8"}')!)).toBe("a7a8q");
    expect(moveToUci(findMoveInText(promotion, '{"move":"a7a8n"}')!)).toBe("a7a8n");
  });

  it("counts material from White's side", () => {
    expect(materialBalance(parseFen(START_FEN))).toBe(0);
    expect(materialBalance(parseFen("4k3/8/8/8/8/8/8/R3K3 w - - 0 1"))).toBe(5);
  });
});
