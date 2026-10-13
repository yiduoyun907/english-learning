/**
 * 听写比对：把用户默写的内容与原文逐词对齐。
 *
 * 纯函数、无副作用，便于单元测试。比对时忽略大小写与标点，
 * 因此「don't」与「dont」、「Morning.」与「morning」视为一致；
 * 但返回的 token 保留原文词形，供界面展示正确答案。
 */

/** 按句切分。文章以空行分段，段内按 . ! ? 断句。 */
export function splitSentences(content) {
  return String(content || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** 拆词，同时保留原形与用于比较的规范形 */
function splitWords(text) {
  return String(text || '')
    .split(/\s+/)
    .map((raw) => ({ raw, norm: raw.toLowerCase().replace(/[^a-z0-9]/g, '') }))
    .filter((item) => item.norm.length > 0);
}

/**
 * 用最长公共子序列对齐原文与默写内容。
 * @returns {{tokens: Array<{text: string, status: 'correct'|'missing'|'extra'}>,
 *            accuracy: number, correctCount: number, expectedCount: number}}
 *   correct = 写对；missing = 漏写（text 为原文词）；extra = 多写（text 为用户输入词）
 */
export function alignWords(answerText, inputText) {
  const expected = splitWords(answerText);
  const actual = splitWords(inputText);

  const rows = expected.length;
  const cols = actual.length;

  // lengths[i][j] = expected[i..] 与 actual[j..] 的最长公共子序列长度
  const lengths = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        expected[i].norm === actual[j].norm
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const tokens = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (expected[i].norm === actual[j].norm) {
      tokens.push({ text: expected[i].raw, status: 'correct' });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      tokens.push({ text: expected[i].raw, status: 'missing' });
      i += 1;
    } else {
      tokens.push({ text: actual[j].raw, status: 'extra' });
      j += 1;
    }
  }

  while (i < rows) {
    tokens.push({ text: expected[i].raw, status: 'missing' });
    i += 1;
  }
  while (j < cols) {
    tokens.push({ text: actual[j].raw, status: 'extra' });
    j += 1;
  }

  const correctCount = tokens.filter((token) => token.status === 'correct').length;
  const accuracy = rows > 0 ? correctCount / rows : 0;

  return { tokens, accuracy, correctCount, expectedCount: rows };
}
