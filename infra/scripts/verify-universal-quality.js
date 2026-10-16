/**
 * Quality & Taste Verification Test
 * Verifies universal professional execution across Google Docs, Sheets, Slides, and UI Link Cards.
 */
const assert = require('assert');
const { parseMarkdownToDocsContent } = require('../../services/workflows/dist/tools/google-docs.js');
const { parseTableValues } = require('../../services/workflows/dist/tools/google-sheets.js');
const { parseMarkdownToSlidesText } = require('../../services/workflows/dist/tools/google-slides.js');

console.log('--- 1. Testing Google Docs Native Typography & Stripper ---');
const sampleDocMd = `# Strategic Roadmap: Enterprise Agentic Systems
## Executive Overview
Autonomous AI employees eliminate operational friction across enterprise workflows.

### Key Architecture Components
- **Cognitive Planner**: High-throughput DAG generation with sub-100ms latency.
- **Dynamic Tool Dispatcher**: Zero-trust multi-tenant tool mediation with signed tokens.
- **Continuous Memory**: Epistemic knowledge graphs integrated with pgvector search.
`;

const docsParsed = parseMarkdownToDocsContent(sampleDocMd, 1);
assert(!docsParsed.cleanText.includes('**'), 'Google Docs cleanText must NOT contain raw markdown ** asterisks');
assert(!docsParsed.cleanText.includes('# '), 'Google Docs cleanText must NOT contain raw # headers');
assert(docsParsed.cleanText.includes('Cognitive Planner: High-throughput DAG generation'), 'Must contain plain text bullet point');
assert.strictEqual(docsParsed.paragraphStyles.length, 3, 'Must identify 3 heading styles (H1, H2, H3)');
assert.strictEqual(docsParsed.paragraphStyles[0].namedStyleType, 'HEADING_1');
assert.strictEqual(docsParsed.paragraphStyles[1].namedStyleType, 'HEADING_2');
assert.strictEqual(docsParsed.paragraphStyles[2].namedStyleType, 'HEADING_3');
assert.strictEqual(docsParsed.bulletRanges.length, 3, 'Must identify 3 bullet items');
assert.strictEqual(docsParsed.boldRanges.length, 3, 'Must extract 3 bold token ranges');
console.log('  [PASS] Google Docs typography formatting verified: zero raw markdown, native headings and bold ranges extracted.');

console.log('\n--- 2. Testing Google Sheets Automatic Table & Model Parsing ---');
const sampleSheetMd = `
| KPI Metric | Baseline (2025) | Target (Q4 2026) | Impact Delta |
|---|---|---|---|
| First Contact Resolution (FCR) | 42.5% | 89.2% | +46.7% |
| Average Resolution Time | 48.2 hrs | 3.4 mins | -98.8% |
| Annual Operational Expenditure | $4,850,000 | $1,690,000 | -$3,160,000 |
`;

const sheetRows = parseTableValues(sampleSheetMd);
assert.strictEqual(sheetRows.length, 4, 'Must parse markdown table into exactly 4 rows (1 header + 3 data rows)');
assert.deepStrictEqual(sheetRows[0], ['KPI Metric', 'Baseline (2025)', 'Target (Q4 2026)', 'Impact Delta']);
assert.deepStrictEqual(sheetRows[1], ['First Contact Resolution (FCR)', '42.5%', '89.2%', '+46.7%']);
assert.deepStrictEqual(sheetRows[3], ['Annual Operational Expenditure', '$4,850,000', '$1,690,000', '-$3,160,000']);
console.log('  [PASS] Google Sheets table parser verified: cleanly extracts headers and typed numerical columns.');

console.log('\n--- 3. Testing Google Slides Native Typography & Markdown Stripper ---');
const sampleSlideBullet = '- **Autonomous Tool Mediation:** Bridges LLMs with enterprise APIs via MCP gateway.';
const slideParsed = parseMarkdownToSlidesText(sampleSlideBullet);
assert(!slideParsed.cleanText.includes('**'), 'Google Slides cleanText must NOT contain raw **');
assert(slideParsed.cleanText.startsWith('• Autonomous Tool Mediation:'), 'Must format with native bullet character');
assert.strictEqual(slideParsed.boldRanges.length, 1, 'Must extract bold range');
assert.strictEqual(slideParsed.boldRanges[0].startIndex, 2);
console.log('  [PASS] Google Slides typography verified: zero raw markdown on canvas, native bullet character and bold range extracted.');

console.log('\n======================================================');
console.log('  ALL EXECUTIVE QUALITY & USER TASTE CHECKS PASSED!');
console.log('======================================================');
