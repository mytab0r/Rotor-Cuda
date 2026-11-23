/* Build-time puzzle data and metadata contract.
 *
 * `data/puzzles.json` must reproduce the `PUZZLE_TARGETS` table in
 * `src/coordinator/puzzles.rs` exactly; this test parses the Rust source and
 * compares every row, so the web build cannot drift from the coordinator's
 * embedded dataset. It also pins the range arithmetic, the metadata bounds the
 * SEO gate enforces, and the indexability rule the sitemap uses. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  HUB_DESCRIPTION,
  HUB_TITLE,
  INDEXABLE_PUZZLES,
  PUZZLES,
  PUZZLE_COUNT,
  SOLVED_COUNT,
  UNSOLVED_COUNT,
  addressTypeLabel,
  detailDescription,
  detailTitle,
  isIndexable,
  puzzleByNumber,
  puzzleRange,
} from '../src/lib/puzzles.js';

const RUST_SOURCE = fileURLToPath(
  new URL('../../../src/coordinator/puzzles.rs', import.meta.url),
);

interface RustPuzzle {
  number: number;
  target: string;
  solved: boolean;
}

function rustPuzzles(): RustPuzzle[] {
  const source = readFileSync(RUST_SOURCE, 'utf8');
  const start = source.indexOf('const PUZZLE_TARGETS');
  if (start < 0) throw new Error('PUZZLE_TARGETS not found in puzzles.rs');
  const end = source.indexOf('];', start);
  const body = source.slice(source.indexOf('[', start), end);
  const rows: RustPuzzle[] = [];
  for (const match of body.matchAll(/\(\s*"([13][1-9A-HJ-NP-Za-km-z]{25,34})"\s*,\s*(true|false)\s*\)/g)) {
    rows.push({ number: rows.length + 1, target: match[1], solved: match[2] === 'true' });
  }
  return rows;
}

test('data/puzzles.json matches the coordinator table row for row', () => {
  const rust = rustPuzzles();
  assert.equal(rust.length, PUZZLE_COUNT);
  assert.deepEqual(
    PUZZLES.map(({ number, target, solved }) => ({ number, target, solved })),
    rust,
  );
  assert.equal(SOLVED_COUNT, rust.filter((row) => row.solved).length);
  assert.equal(UNSOLVED_COUNT, rust.filter((row) => !row.solved).length);
});

test('the dataset keeps 160 numbered rows, 83 solved and unique P2PKH targets', () => {
  assert.equal(PUZZLE_COUNT, 160);
  assert.equal(SOLVED_COUNT, 83);
  assert.equal(UNSOLVED_COUNT, 77);
  assert.equal(new Set(PUZZLES.map((puzzle) => puzzle.target)).size, 160);
  for (const puzzle of PUZZLES) {
    assert.match(puzzle.target, /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
  }
  assert.equal(addressTypeLabel(), 'P2PKH legacy');
  assert.equal(puzzleByNumber(71)?.target, '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU');
  assert.equal(puzzleByNumber(71)?.solved, false);
  assert.equal(puzzleByNumber(0), undefined);
  assert.equal(puzzleByNumber(161), undefined);
});

test('the range is the inclusive bit tower slice with padded hex', () => {
  const range = puzzleRange(71);
  assert.equal(
    range.startHex,
    '0000000000000000000000000000000000000000000000400000000000000000',
  );
  assert.equal(
    range.endHex,
    '00000000000000000000000000000000000000000000007fffffffffffffffff',
  );
  assert.equal(range.bits, 70);
  assert.equal(range.keyspaceDecimal, '1,180,591,620,717,411,303,424');
  assert.deepEqual(puzzleRange(1), {
    startHex: '0000000000000000000000000000000000000000000000000000000000000001',
    endHex: '0000000000000000000000000000000000000000000000000000000000000001',
    startDecimal: '1',
    endDecimal: '1',
    keyspaceDecimal: '1',
    bits: 0,
  });
  assert.equal(puzzleRange(160).startHex.length, 64);
  assert.equal(puzzleRange(160).endHex.length, 64);
});

test('every detail page is indexable and every page has bounded, unique metadata', () => {
  assert.equal(INDEXABLE_PUZZLES.length, PUZZLE_COUNT);
  assert.ok(PUZZLES.every(isIndexable));

  assert.ok(HUB_TITLE.length <= 60, `hub title ${HUB_TITLE.length}`);
  assert.ok(HUB_DESCRIPTION.length >= 120 && HUB_DESCRIPTION.length <= 160);
  assert.match(HUB_DESCRIPTION, /\b160\b/);

  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const puzzle of PUZZLES) {
    const title = detailTitle(puzzle.number);
    const description = detailDescription(puzzle.number);
    assert.ok(title.length >= 50 && title.length <= 60, `#${puzzle.number} title ${title.length}`);
    assert.ok(
      description.length >= 120 && description.length <= 160,
      `#${puzzle.number} description ${description.length}`,
    );
    assert.ok(description.includes(puzzle.target), `#${puzzle.number} description names its target`);
    assert.ok(description.includes(puzzle.solved ? 'solved' : 'unsolved'));
    titles.add(title);
    descriptions.add(description);
  }
  assert.equal(titles.size, PUZZLE_COUNT);
  assert.equal(descriptions.size, PUZZLE_COUNT);
});
