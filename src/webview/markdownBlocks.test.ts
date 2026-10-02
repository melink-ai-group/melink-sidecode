import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownBlocks } from './markdownBlocks.ts';

test('a pipe table stays a table, with one row per line', () => {
  const blocks = parseMarkdownBlocks(
    [
      'Current callers are safe.',
      '',
      '| Root | Backend | Callers |',
      '| --- | --- | --- |',
      '| boards | `post / get "/"` | `/boards/` |',
      '| cards | `post / get "/"` | `/cards/` |',
      '',
      'The callers already include the trailing slash.'
    ].join('\n')
  );

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['paragraph', 'table', 'paragraph']
  );
  const table = blocks[1];
  assert.equal(table.kind, 'table');
  if (table.kind !== 'table') {
    return;
  }
  assert.deepEqual(table.headers, ['Root', 'Backend', 'Callers']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0], 'boards');
  assert.equal(table.rows[1][2], '`/cards/`');
});

test('a single newline inside a paragraph is kept as a break', () => {
  const blocks = parseMarkdownBlocks('First line.\nSecond line.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
  if (blocks[0].kind === 'paragraph') {
    assert.equal(blocks[0].text, 'First line.\nSecond line.');
  }
});

test('a pipe in prose is not treated as a table', () => {
  const blocks = parseMarkdownBlocks('Use a | b when you mean either.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
});
