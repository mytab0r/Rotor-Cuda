/* Build-time Bitcoin puzzle data for the Astro puzzle pages.
 *
 * `data/puzzles.json` is the machine source this build reads. It reproduces the
 * `PUZZLE_TARGETS` table in `src/coordinator/puzzles.rs` exactly (160 public
 * targets, the same solved flags); `web/tests/puzzles.test.ts` parses the Rust
 * table and fails when the two drift, so neither becomes a second truth.
 *
 * Puzzle `n` covers the inclusive private-key range `2^(n-1) .. 2^n - 1`.
 * The data carries the target and the solved flag only. There is no reward,
 * solver, key or date field, so the pages must not render one.
 *
 * This module is imported at Astro build time only; it never reaches the
 * browser, and no private key exists in the dataset to leak. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PuzzleRecord {
  /** 1-based puzzle number; the data must cover 1..count without gaps. */
  number: number;
  /** Public Bitcoin target address (Base58, P2PKH legacy). */
  target: string;
  /** Solved flag copied from the public dataset; never inferred. */
  solved: boolean;
}

interface PuzzleFile {
  source: string;
  count: number;
  solved: number;
  unsolved: number;
  range: string;
  puzzles: PuzzleRecord[];
}

/* Resolve the data file from the Astro build (`web/` cwd) and from the compiled
 * Node tests (`web/.test-build/src/lib/`). Failing every candidate is a build
 * error, not a silent empty table. */
function loadPuzzleFile(): PuzzleFile {
  const candidates = [
    path.resolve(process.cwd(), '../data/puzzles.json'),
    path.resolve(process.cwd(), 'data/puzzles.json'),
    fileURLToPath(new URL('../../../data/puzzles.json', import.meta.url)),
    fileURLToPath(new URL('../../../../data/puzzles.json', import.meta.url)),
  ];
  const failures: string[] = [];
  for (const file of candidates) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as PuzzleFile;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      failures.push(file);
    }
  }
  throw new Error(`data/puzzles.json not found; tried:\n${failures.join('\n')}`);
}

const DATA = loadPuzzleFile();

/* Fail the build loud instead of rendering a partial or shifted table. */
if (DATA.count !== DATA.puzzles.length) {
  throw new Error(`data/puzzles.json: count ${DATA.count} does not match ${DATA.puzzles.length} rows`);
}
DATA.puzzles.forEach((puzzle, index) => {
  if (puzzle.number !== index + 1) {
    throw new Error(`data/puzzles.json: puzzle ${puzzle.number} is at position ${index + 1}`);
  }
  if (!isP2pkhTarget(puzzle.target)) {
    throw new Error(`data/puzzles.json: puzzle ${puzzle.number} has a non-P2PKH target`);
  }
});
if (new Set(DATA.puzzles.map((puzzle) => puzzle.target)).size !== DATA.puzzles.length) {
  throw new Error('data/puzzles.json: duplicate target address');
}
const solvedCount = DATA.puzzles.filter((puzzle) => puzzle.solved).length;
if (solvedCount !== DATA.solved || DATA.unsolved !== DATA.count - solvedCount) {
  throw new Error('data/puzzles.json: solved/unsolved totals do not match the rows');
}

export const PUZZLES: readonly PuzzleRecord[] = DATA.puzzles;
export const PUZZLE_COUNT = DATA.count;
export const SOLVED_COUNT = DATA.solved;
export const UNSOLVED_COUNT = DATA.unsolved;
export const PUZZLE_SOURCE = DATA.source;

/** A public P2PKH target starts with the version byte `1` and is Base58. */
function isP2pkhTarget(target: string): boolean {
  return /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(target);
}

/**
 * Indexability rule for a detail page: the record must carry a well-formed
 * public P2PKH target and a number inside the published set. Every current row
 * passes, so all 160 detail pages are indexable. A future row without a target
 * would render a `noindex` page and stay out of the sitemap instead of shipping
 * a thin page built from a number alone. The prose floor is enforced separately
 * by `scripts/check-seo.mjs` (120 unique visible words).
 */
export function isIndexable(puzzle: PuzzleRecord): boolean {
  return isP2pkhTarget(puzzle.target) && puzzle.number >= 1 && puzzle.number <= PUZZLE_COUNT;
}

export const INDEXABLE_PUZZLES: readonly PuzzleRecord[] = PUZZLES.filter(isIndexable);

export function puzzleByNumber(number: number): PuzzleRecord | undefined {
  if (!Number.isInteger(number) || number < 1 || number > PUZZLE_COUNT) return undefined;
  return PUZZLES[number - 1];
}

export function addressTypeLabel(): string {
  return 'P2PKH legacy';
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface PuzzleRange {
  /** Inclusive start as padded 64-character hex. */
  startHex: string;
  /** Inclusive end as padded 64-character hex. */
  endHex: string;
  /** Decimal value of the start. */
  startDecimal: string;
  /** Decimal value of the end. */
  endDecimal: string;
  /** Decimal number of keys in the range (`2^(n-1)`). */
  keyspaceDecimal: string;
  /** Range width in bits (`n - 1`). */
  bits: number;
}

export function puzzleRange(number: number): PuzzleRange {
  if (puzzleByNumber(number) === undefined) throw new Error(`puzzle ${number} is outside the dataset`);
  const exponent = BigInt(number - 1);
  const start = BigInt(1) << exponent;
  const end = (BigInt(1) << BigInt(number)) - BigInt(1);
  return {
    startHex: start.toString(16).padStart(64, '0'),
    endHex: end.toString(16).padStart(64, '0'),
    startDecimal: groupDigits(start.toString(10)),
    endDecimal: groupDigits(end.toString(10)),
    keyspaceDecimal: groupDigits((end - start + BigInt(1)).toString(10)),
    bits: number - 1,
  };
}

/* Metadata builders live here so the page, the sitemap and the SEO gate agree
 * on one spelling. Both shapes stay inside the gate's 50-60 / 120-160 bounds
 * for every puzzle 1..160; the test asserts the measured range. */
export const HUB_TITLE = `Bitcoin puzzle browser: ${PUZZLE_COUNT} targets, ${SOLVED_COUNT} solved | Crypto`;
export const HUB_DESCRIPTION =
  `Browse all ${PUZZLE_COUNT} public Bitcoin puzzles with target address, key range and solved status. ` +
  `${SOLVED_COUNT} are solved and ${UNSOLVED_COUNT} remain unsolved in the published dataset.`;

export function detailTitle(number: number): string {
  puzzleByNumber(number);
  return `Bitcoin puzzle #${number} — P2PKH target and key range | Crypto`;
}

export function detailDescription(number: number): string {
  const puzzle = puzzleByNumber(number);
  if (!puzzle) throw new Error(`puzzle ${number} is outside the dataset`);
  const bits = number - 1;
  const status = puzzle.solved ? 'solved' : 'unsolved';
  return (
    `Puzzle #${number} covers ${bits}-bit keys from 2^${bits} to 2^${number}−1; ` +
    `target ${puzzle.target}; status ${status}. The page shows facts, never a private key.`
  );
}
