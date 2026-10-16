/**
 * @jest-environment node
 *
 * What every page has to download before it shows anything. Measured in a real browser: the chat-answer widget
 * library's stylesheet (290 KB, 33 KB gzipped) was imported globally, so every page, the sign-in page included, paid
 * for it, although only a chat answer containing an `openui` block uses it. It loads with that block instead.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('first-load weight', () => {
  it('does not import the answer-widget stylesheets for every page', () => {
    expect(read('app/globals.css')).not.toMatch(/@openuidev/);
  });

  it('loads those stylesheets together with the widget that needs them', () => {
    const block = read('components/chat/OpenUiFenceBlock.tsx');
    expect(block).toMatch(/import '@openuidev\/react-ui\/defaults\.css'/);
    expect(block).toMatch(/import '@openuidev\/react-ui\/styles\/index\.css'/);
  });

  it('keeps that widget out of the main bundle (it is loaded only when an answer has one)', () => {
    expect(read('components/chat/FormattedMarkdownResponse.tsx')).toMatch(/dynamic\(\s*\(\) => import\('\.\/OpenUiFenceBlock'\)/);
  });
});
