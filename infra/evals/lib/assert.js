'use strict';

/**
 * Promptfoo-compatible assertion runner for Darex eval goldens.
 * Does not call models. `javascript` asserts receive `{ output }`.
 */

function asString(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function runAssert(assertion, output) {
  const type = assertion && assertion.type;
  const value = assertion ? assertion.value : undefined;
  const text = asString(output);

  switch (type) {
    case 'contains':
      return { pass: text.includes(String(value)), reason: `expected output to contain ${JSON.stringify(value)}` };
    case 'not-contains':
      return { pass: !text.includes(String(value)), reason: `expected output not to contain ${JSON.stringify(value)}` };
    case 'icontains':
      return {
        pass: text.toLowerCase().includes(String(value).toLowerCase()),
        reason: `expected output to contain ${JSON.stringify(value)} (case-insensitive)`,
      };
    case 'equals':
      return { pass: text === String(value), reason: `expected output to equal ${JSON.stringify(value)}` };
    case 'regex': {
      const re = typeof value === 'string' ? new RegExp(value) : value;
      return { pass: re.test(text), reason: `expected output to match ${re}` };
    }
    case 'is-json': {
      try {
        JSON.parse(text);
        return { pass: true, reason: 'json' };
      } catch (err) {
        return { pass: false, reason: `not json: ${err.message}` };
      }
    }
    case 'javascript': {
      try {
        const fn = new Function('output', 'context', `"use strict";\n${value}`);
        const result = fn(output, { output, text });
        const pass = result === true;
        return { pass, reason: pass ? 'javascript assert returned true' : `javascript assert returned ${JSON.stringify(result)}` };
      } catch (err) {
        return { pass: false, reason: `javascript assert threw: ${err.message}` };
      }
    }
    default:
      return { pass: false, reason: `unknown assert type ${JSON.stringify(type)}` };
  }
}

function runAsserts(asserts, output) {
  const list = Array.isArray(asserts) ? asserts : [];
  const results = list.map((a) => ({ assertion: a, ...runAssert(a, output) }));
  const failed = results.filter((r) => !r.pass);
  return { pass: failed.length === 0, results, failed };
}

module.exports = { runAssert, runAsserts, asString };
