// PDBx/mmCIF 语法解析。
// 输出 data block、单值（Item）与 loop（保留声明列序与每个值的原 token 位置）。
// 不假设 loop 字段次序：行按列名映射，列顺序仅用于取值。
// 点号/问号原样保留为 value token；loop 行被截断时不补空字符串，而是登记 issue，
// 已完整的单元格仍带出处返回。

import { tokenize } from './tokenizer.mjs';

const VALUE_TYPES = new Set(['word', 'quoted', 'text']);

function asValue(token) {
  return { token: token.value, loc: token.loc, start: token.start, end: token.end };
}

export function parse(text) {
  const { tokens, issues: lexicalIssues } = tokenize(text);
  const blocks = [];
  const issues = [...lexicalIssues];
  let current = null;
  let index = 0;

  function ensureBlock(token) {
    if (!current) {
      const generated = {
        name: { token: '', loc: token.loc, start: token.start, end: token.end },
        items: new Map(),
        loops: [],
      };
      blocks.push(generated);
      current = generated;
      issues.push({ reason: 'content_before_data_block', location: token.loc, detail: 'data_ 声明前出现内容，已归入未命名 block' });
    }
    return current;
  }

  while (index < tokens.length) {
    const token = tokens[index];

    if (token.type === 'data') {
      current = { name: asValue(token), items: new Map(), loops: [] };
      blocks.push(current);
      index += 1;
      continue;
    }

    if (token.type === 'stop') { index += 1; continue; }

    const block = ensureBlock(token);

    if (token.type === 'loop') {
      const loopStart = token;
      index += 1;
      const columns = [];
      while (index < tokens.length && tokens[index].type === 'item') {
        columns.push(asValue(tokens[index]));
        index += 1;
      }
      if (columns.length === 0) {
        issues.push({ reason: 'empty_loop', location: loopStart.loc, detail: 'loop_ 后没有任何字段名' });
        continue;
      }
      const rows = [];
      let rowIndex = 0;
      while (index < tokens.length && VALUE_TYPES.has(tokens[index].type)) {
        const cells = [];
        const rowFirstToken = tokens[index];
        let truncated = false;
        for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
          const cellToken = tokens[index];
          if (cellToken === undefined || !VALUE_TYPES.has(cellToken.type)) {
            truncated = true;
            break;
          }
          cells.push({ column: columns[columnIndex].token, ...asValue(cellToken) });
          index += 1;
        }
        const row = {
          rowIndex,
          loc: rowFirstToken.loc,
          start: rowFirstToken.start,
          truncated,
          cells,
        };
        rows.push(row);
        if (truncated) {
          const present = cells.map(cell => cell.column);
          issues.push({
            reason: 'loop_row_truncated',
            location: rowFirstToken.loc,
            detail: `loop（首列 ${columns[0].token}）第 ${rowIndex + 1} 行被截断：应有 ${columns.length} 列，实际取得 ${cells.length} 列`,
            category: columns[0].token.split('.')[0],
            expectedColumns: columns.length,
            presentColumns: present,
          });
          break; // 截断行之后的 token 无法安全判定列归属，停止消费本 loop
        }
        rowIndex += 1;
      }
      block.loops.push({ columns, rows, loc: loopStart.loc });
      continue;
    }

    if (token.type === 'item') {
      const name = asValue(token);
      const next = tokens[index + 1];
      if (next && VALUE_TYPES.has(next.type)) {
        block.items.set(name.token, { name, value: asValue(next) });
        index += 2;
      } else {
        issues.push({ reason: 'item_without_value', location: name.loc, detail: `字段 ${name.token} 缺少取值` });
        block.items.set(name.token, { name, value: null });
        index += 1;
      }
      continue;
    }

    // 理论上词法不会产生其他类型，遇到时显式报告而不是静默跳过。
    issues.push({ reason: 'unexpected_token', location: token.loc, detail: `未预期的词法 token：${token.type}` });
    index += 1;
  }

  return { blocks, issues };
}
