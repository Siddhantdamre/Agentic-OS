import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownToDocsContent } from './google-docs.js';
import { parseTableValues } from './google-sheets.js';
import { parseMarkdownToSlidesText } from './google-slides.js';

describe('Google Docs Markdown Parser', () => {
  it('strips markdown syntax and identifies headings, bullets, and bold spans', () => {
    const markdown = `# Architecture Overview
## Key Subsystems
- **Autonomous Planner**: Generates multi-step DAGs with deterministic SLAs.
- **Dynamic Tools**: Connects 96 enterprise connectors natively.
### Implementation Details
Normal explanatory text with **critical metrics** highlighted.`;

    const parsed = parseMarkdownToDocsContent(markdown, 1);

    // Verify raw asterisks and hashtags are stripped from the clean text
    assert.ok(!parsed.cleanText.includes('**'), 'Clean text must not contain raw bold asterisks');
    assert.ok(!parsed.cleanText.includes('# '), 'Clean text must not contain raw markdown headers');
    assert.ok(!parsed.cleanText.includes('## '), 'Clean text must not contain raw markdown subheaders');
    assert.ok(!parsed.cleanText.includes('### '), 'Clean text must not contain raw markdown section headers');

    // Verify clean text contains the actual words
    assert.ok(parsed.cleanText.includes('Architecture Overview'));
    assert.ok(parsed.cleanText.includes('Autonomous Planner: Generates multi-step DAGs with deterministic SLAs.'));
    assert.ok(parsed.cleanText.includes('Dynamic Tools: Connects 96 enterprise connectors natively.'));
    assert.ok(parsed.cleanText.includes('Implementation Details'));
    assert.ok(parsed.cleanText.includes('Normal explanatory text with critical metrics highlighted.'));

    // Verify paragraph styles (H1, H2, H3)
    assert.strictEqual(parsed.paragraphStyles.length, 3);
    assert.strictEqual(parsed.paragraphStyles[0].namedStyleType, 'HEADING_1');
    assert.strictEqual(parsed.paragraphStyles[1].namedStyleType, 'HEADING_2');
    assert.strictEqual(parsed.paragraphStyles[2].namedStyleType, 'HEADING_3');

    // Verify bullets
    assert.strictEqual(parsed.bulletRanges.length, 2);

    // Verify bold spans
    assert.strictEqual(parsed.boldRanges.length, 3);
    for (const b of parsed.boldRanges) {
      assert.ok(b.endIndex > b.startIndex, 'Bold range end must be greater than start');
    }
  });
});

describe('Google Sheets Table Parser', () => {
  it('parses markdown tables into 2D cell arrays', () => {
    const mdTable = `
| Quarter | Target ARR | Actual ARR | Growth % |
|---|---|---|---|
| Q1 2026 | $2.5M | $2.8M | 112% |
| Q2 2026 | $3.5M | $3.9M | 111% |
| Q3 2026 | $5.0M | $5.4M | 108% |
`;
    const rows = parseTableValues(mdTable);
    assert.strictEqual(rows.length, 4); // 1 header + 3 data rows
    assert.deepStrictEqual(rows[0], ['Quarter', 'Target ARR', 'Actual ARR', 'Growth %']);
    assert.deepStrictEqual(rows[1], ['Q1 2026', '$2.5M', '$2.8M', '112%']);
    assert.deepStrictEqual(rows[3], ['Q3 2026', '$5.0M', '$5.4M', '108%']);
  });

  it('parses array of objects into header row and value rows', () => {
    const objects = [
      { employee: 'Agent Alpha', tasksCompleted: 42, errorRate: '0.2%' },
      { employee: 'Agent Beta', tasksCompleted: 88, errorRate: '0.1%' },
    ];
    const rows = parseTableValues(objects);
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows[0], ['employee', 'tasksCompleted', 'errorRate']);
    assert.deepStrictEqual(rows[1], ['Agent Alpha', 42, '0.2%']);
    assert.deepStrictEqual(rows[2], ['Agent Beta', 88, '0.1%']);
  });
});

describe('Google Slides Typography & Markdown Stripper', () => {
  it('strips bold markers and returns native character offsets', () => {
    const raw = '- **Strategic Autonomy:** Eliminates human bottlenecks across tier-1 workflows.';
    const result = parseMarkdownToSlidesText(raw);

    assert.ok(!result.cleanText.includes('**'), 'Slides clean text must not contain **');
    assert.strictEqual(result.cleanText, '• Strategic Autonomy: Eliminates human bottlenecks across tier-1 workflows.');
    assert.strictEqual(result.boldRanges.length, 1);
    assert.strictEqual(result.boldRanges[0].startIndex, 2);
    assert.strictEqual(result.boldRanges[0].endIndex, 2 + 'Strategic Autonomy:'.length);
  });
});
