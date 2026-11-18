// PDBx/mmCIF 词法切分。
// 职责仅限词法：识别 data_ 关键字、loop_、stop_、裸词、单引号、双引号、
// 行首分号多行文本与注释，并为每个 token 保留原行列与字节区间。
// 点号 "." 与问号 "?" 是普通值 token，缺失语义交给上层，绝不在此统一成空字符串。

function positionAt(text, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) { line += 1; column = 1; } else column += 1;
  }
  return { line, column, offset };
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

export function tokenize(text) {
  const tokens = [];
  const issues = [];
  let offset = 0;
  const length = text.length;

  function push(type, start, end, value) {
    const startPosition = positionAt(text, start);
    const endPosition = positionAt(text, end);
    tokens.push({ type, value, start: startPosition, end: endPosition, loc: `line:${startPosition.line}:col:${startPosition.column}:offset:${start}-${end}` });
  }

  while (offset < length) {
    const char = text[offset];

    if (isWhitespace(char)) { offset += 1; continue; }

    // 注释只在引号外生效，直到行尾；注释内容不产生 token。
    if (char === '#') {
      while (offset < length && text[offset] !== '\n') offset += 1;
      continue;
    }

    // 行首分号多行文本（分号必须出现在行首，前面只能是空白）。
    if (char === ';' && (offset === 0 || text[offset - 1] === '\n' || text[offset - 1] === '\r')) {
      const start = offset;
      offset += 1;
      const contentStart = offset;
      let closed = false;
      while (offset < length) {
        if (text[offset] === ';' && (text[offset - 1] === '\n' || text[offset - 1] === '\r')) {
          closed = true;
          break;
        }
        offset += 1;
      }
      if (!closed) {
        issues.push({ reason: 'unterminated_multiline_text', location: `line:${positionAt(text, start).line}`, detail: '分号多行文本在文件结束前未闭合' });
        push('text', start, length, text.slice(contentStart, length).replace(/[\r\n]+$/, ''));
        offset = length;
      } else {
        const content = text.slice(contentStart, offset);
        offset += 1; // 跳过闭合分号
        push('text', start, offset, content.replace(/[\r\n]+$/, ''));
      }
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      const start = offset;
      offset += 1;
      const contentStart = offset;
      let closed = false;
      while (offset < length) {
        if (text[offset] === quote) {
          // 闭合引号后必须紧跟空白或 EOF，否则属于裸词的一部分按规范不应出现，
          // 这里按闭合处理并记录问题，避免静默吞字符。
          const next = text[offset + 1];
          if (next === undefined || isWhitespace(next)) { closed = true; break; }
          issues.push({ reason: 'quote_not_followed_by_whitespace', location: `line:${positionAt(text, offset).line}:col:${positionAt(text, offset).column}` });
          closed = true;
          break;
        }
        offset += 1;
      }
      if (!closed) {
        issues.push({ reason: 'unterminated_quoted_string', location: `line:${positionAt(text, start).line}:col:${positionAt(text, start).column}`, detail: '引号字符串在文件结束前未闭合' });
        push('quoted', start, length, text.slice(contentStart, length));
        offset = length;
      } else {
        const content = text.slice(contentStart, offset);
        offset += 1; // 跳过闭合引号
        push('quoted', start, offset, content);
      }
      continue;
    }

    // 裸词：直到空白或注释符。data_/loop_/stop_ 前缀在此识别。
    const start = offset;
    while (offset < length && !isWhitespace(text[offset]) && text[offset] !== '#') offset += 1;
    const word = text.slice(start, offset);
    if (word.startsWith('data_')) push('data', start, offset, word.slice(5));
    else if (word === 'loop_') push('loop', start, offset, word);
    else if (word === 'stop_') push('stop', start, offset, word);
    else if (word.startsWith('_')) push('item', start, offset, word);
    else push('word', start, offset, word);
  }

  return { tokens, issues };
}
