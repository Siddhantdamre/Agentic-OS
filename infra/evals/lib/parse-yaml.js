'use strict';

/**
 * Minimal YAML 1.2 subset parser for eval goldens.
 * Supports maps, sequences, quoted scalars, numbers/bools/null, and `|` blocks.
 * No anchors, tags, or flow collections — keep goldens in the indent style.
 */

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || line[i - 1] === ' ') return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s.startsWith('"')) {
      return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return inner.replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function tokenize(text) {
  const lines = text.replace(/\t/g, '  ').split(/\r?\n/);
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripInlineComment(lines[i]);
    if (stripped.trim() === '' || stripped.trim() === '---' || stripped.trim() === '...') continue;
    const indent = stripped.match(/^( *)/)[1].length;
    tokens.push({ indent, content: stripped.slice(indent), line: i + 1 });
  }
  return tokens;
}

function parseBlock(tokens, index, minIndent) {
  if (index >= tokens.length) return { value: null, next: index };
  const start = tokens[index];
  if (start.indent < minIndent) return { value: null, next: index };

  if (start.content === '-' || start.content.startsWith('- ')) {
    return parseSeq(tokens, index, start.indent);
  }
  return parseMap(tokens, index, start.indent);
}

function parseSeq(tokens, index, indent) {
  const seq = [];
  let i = index;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent < indent) break;
    if (tok.indent > indent) {
      throw new Error(`YAML indent error at line ${tok.line}: ${tok.content}`);
    }
    if (!(tok.content === '-' || tok.content.startsWith('- '))) break;

    const rest = tok.content === '-' ? '' : tok.content.slice(2).trim();
    if (rest === '' || rest === '|' || rest === '>') {
      if (rest === '|' || rest === '>') {
        const block = readBlockScalar(tokens, i + 1, indent + 2, rest);
        seq.push(block.value);
        i = block.next;
      } else if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const nested = parseBlock(tokens, i + 1, indent + 1);
        seq.push(nested.value);
        i = nested.next;
      } else {
        seq.push(null);
        i += 1;
      }
    } else if (/^[^:]+:(\s|$)/.test(rest) || rest.endsWith(':') || rest.endsWith(': |') || rest.endsWith(': >')) {
      const inlineMapLine = { indent: indent + 2, content: rest, line: tok.line };
      const injected = [inlineMapLine, ...tokens.slice(i + 1)];
      const nested = parseMap(injected, 0, indent + 2);
      seq.push(nested.value);
      i = i + nested.next;
    } else {
      seq.push(parseScalar(rest));
      i += 1;
    }
  }
  return { value: seq, next: i };
}

function parseMap(tokens, index, indent) {
  const map = {};
  let i = index;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.indent < indent) break;
    if (tok.indent > indent) {
      throw new Error(`YAML indent error at line ${tok.line}: ${tok.content}`);
    }
    if (tok.content === '-' || tok.content.startsWith('- ')) break;

    const colon = splitKeyValue(tok.content);
    if (!colon) {
      throw new Error(`YAML expected key: value at line ${tok.line}: ${tok.content}`);
    }
    const { key, valueRaw } = colon;

    if (valueRaw === '|' || valueRaw === '>') {
      const block = readBlockScalar(tokens, i + 1, indent + 2, valueRaw);
      map[key] = block.value;
      i = block.next;
    } else if (valueRaw === '') {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const nested = parseBlock(tokens, i + 1, indent + 1);
        map[key] = nested.value;
        i = nested.next;
      } else {
        map[key] = null;
        i += 1;
      }
    } else {
      map[key] = parseScalar(valueRaw);
      i += 1;
    }
  }
  return { value: map, next: i };
}

function splitKeyValue(content) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inDouble && content[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const after = content.slice(i + 1);
      if (after === '' || after.startsWith(' ')) {
        return { key: unquoteKey(content.slice(0, i).trim()), valueRaw: after.trim() };
      }
    }
  }
  return null;
}

function unquoteKey(key) {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

function readBlockScalar(tokens, index, minIndent, style) {
  const lines = [];
  let i = index;
  while (i < tokens.length && tokens[i].indent >= minIndent) {
    lines.push(' '.repeat(tokens[i].indent - minIndent) + tokens[i].content);
    i += 1;
  }
  const joined = style === '>' ? lines.join(' ').trimEnd() : lines.join('\n');
  return { value: joined.replace(/\n$/, ''), next: i };
}

function parseYaml(text) {
  const tokens = tokenize(String(text || ''));
  if (tokens.length === 0) return null;
  const { value } = parseBlock(tokens, 0, 0);
  return value;
}

module.exports = { parseYaml };

if (require.main === module) {
  const sample = `
# comment
tests:
  - description: "hello"
    vars:
      prompt: What did we last show the Kapoors?
      count: 3
      ok: true
    metadata:
      negativeOutput: |
        line one
        line two
    assert:
      - type: contains
        value: no stored memory
`;
  const parsed = parseYaml(sample);
  const t = parsed.tests[0];
  const checks = [
    t.description === 'hello',
    t.vars.prompt.includes('Kapoors'),
    t.vars.count === 3,
    t.vars.ok === true,
    t.metadata.negativeOutput.includes('line two'),
    t.assert[0].type === 'contains',
    t.assert[0].value === 'no stored memory',
  ];
  if (checks.some((c) => !c)) {
    console.error('parse-yaml self-check failed', JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  console.log('parse-yaml self-check ok');
}
