import { Buffer } from 'node:buffer';

// PDBx/mmCIF 词法与语法解析。
// 设计约束（见 docs/source-contract.md）：
// - 不假设 loop 列顺序，按列名取值；
// - 保留每个值的原 token：'.'（不适用）与 '?'（未知）语义不同，绝不归并为空字符串；
// - 每个 token 记录 1 起算的行列与 UTF-8 字节区间，出处可回到原 data block 和行列；
// - 分号多行值只在行首识别；截断的 loop 行产生 issue，不产出半截观察，也不丢弃已完整的行。

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

function classifyBare(word) {
  if (word.startsWith('data_') && word.length > 5) return { type: 'data', name: word.slice(5) };
  if (word === 'loop_') return { type: 'loop' };
  if (word === 'stop_') return { type: 'stop' };
  if (word === 'global_') return { type: 'global' };
  if (word === 'save_') return { type: 'save', name: '' };
  if (word.startsWith('save_') && word.length > 5) return { type: 'save', name: word.slice(5) };
  if (word.startsWith('_')) return { type: 'item', name: word };
  return { type: 'value' };
}

export function tokenize(text) {
  const tokens = [];
  const issues = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let column = 1;
  let byteOffset = 0;

  const snapshot = () => ({ offset: byteOffset, line, column });

  function advance(steps = 1) {
    for (let k = 0; k < steps; k += 1) {
      const ch = text[i];
      byteOffset += Buffer.byteLength(ch, 'utf8');
      if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
    }
  }

  function skipIgnorable() {
    while (i < n) {
      const ch = text[i];
      if (WHITESPACE.has(ch)) {
        advance();
      } else if (ch === '#') {
        while (i < n && text[i] !== '\n') advance();
      } else {
        break;
      }
    }
  }

  while (i < n) {
    skipIgnorable();
    if (i >= n) break;
    const start = snapshot();
    const ch = text[i];

    if (ch === ';' && column === 1) {
      // 行首分号多行文本
      advance(); // 开头的 ;
      if (text[i] === '\r') advance();
      if (text[i] === '\n') advance();
      const lines = [];
      let closed = false;
      while (i < n) {
        if (column === 1 && text[i] === ';') {
          closed = true;
          advance(); // 结尾的 ;
          while (i < n && text[i] !== '\n') advance();
          break;
        }
        let j = i;
        while (j < n && text[j] !== '\n') j += 1;
        const piece = text.slice(i, j);
        advance(piece.length);
        if (text[i] === '\r') advance();
        if (text[i] === '\n') advance();
        lines.push(piece);
      }
      const end = snapshot();
      if (!closed) {
        issues.push({ reason: 'unterminated_semicolon_text', message: '分号多行值缺少行首结束分号',
          location: start, end });
      }
      tokens.push({ type: 'value', value: lines.join('\n'), quoted: 'semicolon', start, end });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      advance(); // 开引号
      const contentStart = i;
      // 纯前瞻扫描闭合位置，不修改解析位置状态，换行计数交给 advance
      let j = i;
      while (j < n) {
        if (text[j] === quote) {
          const after = text[j + 1];
          if (after === undefined || WHITESPACE.has(after) || after === '#') break;
        }
        j += 1;
      }
      const value = text.slice(contentStart, j);
      if (j >= n) {
        // 一路走到 EOF 也没遇到合法闭合引号
        advance(j - i);
        const end = snapshot();
        issues.push({ reason: 'unterminated_quoted_value', message: '引号值缺少闭合引号',
          location: start, end });
        tokens.push({ type: 'value', value, quoted: quote === '"' ? 'double' : 'single', start, end });
        continue;
      }
      advance(j - i); // 内容
      advance(); // 闭引号
      const end = snapshot();
      tokens.push({ type: 'value', value, quoted: quote === '"' ? 'double' : 'single', start, end });
      continue;
    }

    // 裸 token：读到空白或注释符为止
    let j = i;
    while (j < n && !WHITESPACE.has(text[j]) && text[j] !== '#') j += 1;
    const word = text.slice(i, j);
    advance(j - i);
    const end = snapshot();
    const kind = classifyBare(word);
    tokens.push({ ...kind, value: word, quoted: false, start, end });
  }

  return { tokens, issues };
}

function locationOf(token) {
  return { offset: token.start.offset, line: token.start.line, column: token.start.column };
}

export function parseMmCif(text) {
  const { tokens, issues } = tokenize(text);
  const blocks = [];
  let block = null;
  let p = 0;

  const ensureBlock = (token) => {
    if (block) return block;
    block = { name: '', items: [], loops: [] };
    blocks.push(block);
    issues.push({ reason: 'content_before_data_block', message: 'data block 标题前出现内容，已归入匿名 block',
      location: locationOf(token) });
    return block;
  };

  while (p < tokens.length) {
    const token = tokens[p];

    if (token.type === 'data') {
      block = { name: token.name, items: [], loops: [] };
      blocks.push(block);
      p += 1;
      continue;
    }

    if (token.type === 'global') {
      issues.push({ reason: 'unsupported_global_section', message: 'global_ 段不在本接收契约范围内',
        block: block?.name || '', location: locationOf(token) });
      p += 1;
      while (p < tokens.length && tokens[p].type !== 'data') p += 1;
      continue;
    }

    if (token.type === 'save') {
      issues.push({ reason: 'unsupported_save_frame', message: 'save frame 不在本接收契约范围内，已跳过',
        block: block?.name || '', location: locationOf(token) });
      let depth = 1;
      p += 1;
      while (p < tokens.length && depth > 0) {
        if (tokens[p].type === 'save') depth -= 1;
        p += 1;
      }
      continue;
    }

    if (token.type === 'loop') {
      const target = ensureBlock(token);
      const headerStart = locationOf(token);
      p += 1;
      const columns = [];
      const seen = new Set();
      let headerEnd = token.end;
      while (p < tokens.length && tokens[p].type === 'item') {
        const header = tokens[p];
        if (seen.has(header.name)) {
          issues.push({ reason: 'duplicate_loop_column', message: `loop 列名重复: ${header.name}，按首次出现取值`,
            block: target.name, location: locationOf(header) });
        } else {
          columns.push(header.name);
          seen.add(header.name);
        }
        headerEnd = header.end;
        p += 1;
      }
      if (columns.length === 0) {
        issues.push({ reason: 'loop_without_columns', message: 'loop_ 后缺少列名',
          block: target.name, location: headerStart });
        continue;
      }
      const category = columns[0].split('.')[0];
      const values = [];
      while (p < tokens.length && tokens[p].type === 'value') {
        values.push(tokens[p]);
        p += 1;
      }
      const loop = { category, columns, headerStart, headerEnd, rows: [] };
      target.loops.push(loop);
      if (values.length === 0) {
        issues.push({ reason: 'loop_without_rows', message: `类别 ${category} 的 loop 没有任何数据行`,
          block: target.name, location: headerStart });
        continue;
      }
      const width = columns.length;
      const fullCount = Math.floor(values.length / width);
      for (let r = 0; r < fullCount; r += 1) {
        const slice = values.slice(r * width, (r + 1) * width);
        const cells = slice.map((valueToken, index) => ({ name: columns[index], token: valueToken }));
        loop.rows.push({ ordinal: r, cells, start: slice[0].start, end: slice[slice.length - 1].end });
      }
      const remainder = values.length % width;
      if (remainder !== 0) {
        const firstLeftover = values[fullCount * width];
        issues.push({ reason: 'truncated_loop_row',
          message: `类别 ${category} 最后一行被截断：现有 ${remainder}/${width} 个值，该行不登记为观察`,
          block: target.name, location: locationOf(firstLeftover),
          end: firstLeftover.start });
      }
      continue;
    }

    if (token.type === 'item') {
      const target = ensureBlock(token);
      const next = tokens[p + 1];
      if (!next || next.type !== 'value') {
        issues.push({ reason: 'missing_item_value', message: `单值项目 ${token.name} 缺少取值`,
          block: target.name, location: locationOf(token) });
        target.items.push({ name: token.name, item: token, value: null });
        p += 1;
        continue;
      }
      target.items.push({ name: token.name, item: token, value: next });
      p += 2;
      continue;
    }

    if (token.type === 'stop') {
      p += 1;
      continue;
    }

    issues.push({ reason: 'unexpected_token', message: `无法解释的 token: ${token.value}`,
      block: block?.name || '', location: locationOf(token) });
    p += 1;
  }

  return { blocks, issues };
}
