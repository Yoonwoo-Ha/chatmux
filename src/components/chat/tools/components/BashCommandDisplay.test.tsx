import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BashCommandDisplay } from './BashCommandDisplay';

const MULTILINE_COMMAND = [
  "python - <<'EOF'",
  'import pathlib',
  'print(pathlib.Path.cwd())',
  'EOF',
].join('\n');

const render = (props: Parameters<typeof BashCommandDisplay>[0]): string => (
  renderToStaticMarkup(createElement(BashCommandDisplay, props))
);

test('a collapsed command renders only its first line and counts the rest', () => {
  const html = render({ command: MULTILINE_COMMAND, output: 'done' });

  assert.ok(html.includes("python - &lt;&lt;&#x27;EOF&#x27;"), 'first line is shown');
  assert.ok(!html.includes('import pathlib'), 'later command lines stay collapsed');
  assert.ok(html.includes('+3'), 'the hidden command lines are counted');
  // `truncate` carries the one-line clamp, so the chat-wide code wrap rule in
  // index.css must keep skipping elements that declare it.
  assert.ok(html.includes('truncate'), 'the command line keeps its one-line clamp');
});

test('a single-line command shows no hidden-line count', () => {
  const html = render({ command: 'ls -la', output: 'total 0' });

  assert.ok(html.includes('ls -la'));
  assert.ok(!html.includes('+0'), 'nothing is hidden, so no count is rendered');
});

test('a multi-line command stays expandable without any output', () => {
  const html = render({ command: MULTILINE_COMMAND });

  assert.ok(html.includes('aria-expanded="false"'), 'the row is a collapsed disclosure');
  assert.ok(html.includes('role="button"'), 'the row can be opened to read the whole command');
});

test('a single-line command with no output is not a disclosure', () => {
  const html = render({ command: 'ls -la' });

  assert.ok(!html.includes('aria-expanded'), 'there is nothing to expand');
  assert.ok(!html.includes('role="button"'));
});
