import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitSentences, alignWords } from '../src/dictation.js';

test('按句切分：句号、问号、叹号都断句', () => {
  const sentences = splitSentences('I wake up. Do you? Yes! Fine.');
  assert.deepEqual(sentences, ['I wake up.', 'Do you?', 'Yes!', 'Fine.']);
});

test('按句切分：跨段落的换行不影响断句', () => {
  const sentences = splitSentences('First one.\n\nSecond one is here.');
  assert.deepEqual(sentences, ['First one.', 'Second one is here.']);
});

test('完全正确时准确率为 1', () => {
  const result = alignWords('I wake up early', 'I wake up early');
  assert.equal(result.accuracy, 1);
  assert.equal(result.correctCount, 4);
  assert.equal(result.expectedCount, 4);
  assert.ok(result.tokens.every((token) => token.status === 'correct'));
});

test('比对忽略大小写与标点', () => {
  const result = alignWords('I wake up, early.', 'i WAKE up early');
  assert.equal(result.accuracy, 1);
});

test('漏词标记为 missing，并保留原文词形', () => {
  const result = alignWords('I wake up early', 'I up early');
  const missing = result.tokens.filter((token) => token.status === 'missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].text, 'wake');
  assert.equal(result.correctCount, 3);
  assert.equal(result.accuracy, 0.75);
});

test('多写的词标记为 extra', () => {
  const result = alignWords('I wake up', 'I wake up very early');
  const extra = result.tokens.filter((token) => token.status === 'extra');
  assert.equal(extra.length, 2);
  assert.equal(result.accuracy, 1); // 多写不扣分，只提示
});

test('写错词会拆成 missing + extra，准确率相应下降', () => {
  const result = alignWords('I wake up early', 'I wake up late');
  assert.equal(result.correctCount, 3);
  assert.equal(result.accuracy, 0.75);
  const statuses = result.tokens.map((token) => token.status);
  assert.ok(statuses.includes('missing'));
  assert.ok(statuses.includes('extra'));
});

test('完全没写对时准确率为 0', () => {
  const result = alignWords('I wake up early', 'totally different words here');
  assert.equal(result.correctCount, 0);
  assert.equal(result.accuracy, 0);
});

test('空输入时全部标记为 missing', () => {
  const result = alignWords('I wake up', '');
  assert.equal(result.correctCount, 0);
  assert.equal(result.tokens.filter((token) => token.status === 'missing').length, 3);
});

test('撇号差异不视为错误', () => {
  const result = alignWords("I don't know", 'I dont know');
  assert.equal(result.accuracy, 1);
});
