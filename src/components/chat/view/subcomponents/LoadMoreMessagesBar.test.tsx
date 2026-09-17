import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import '../../../../i18n/config';

import LoadMoreMessagesBar from './LoadMoreMessagesBar';

const render = (props: Partial<Parameters<typeof LoadMoreMessagesBar>[0]> = {}): string => (
  renderToStaticMarkup(createElement(LoadMoreMessagesBar, {
    shown: 21,
    total: 261,
    isLoading: false,
    onLoadMore: () => {},
    onLoadAll: () => {},
    ...props,
  }))
);

test('a paginated conversation offers both loads as real buttons', () => {
  const html = render();

  // Two clickable actions, not a scroll instruction: a view that cannot be
  // scrolled has no other way to reach the older pages.
  assert.equal(html.match(/<button/g)?.length, 2);
  assert.ok(html.includes('Load earlier messages'));
  assert.ok(html.includes('Load all messages'));
  assert.ok(html.includes('21') && html.includes('261'), 'the counts stay visible');
  assert.ok(!html.includes('Scroll up'), 'the scroll-only hint is gone');
});

test('both actions are disabled while a load is already running', () => {
  const html = render({ isLoading: true });

  assert.equal(html.match(/<button[^>]*disabled/g)?.length, 2);
});
