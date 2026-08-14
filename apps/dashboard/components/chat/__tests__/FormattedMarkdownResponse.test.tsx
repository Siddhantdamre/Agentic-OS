import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormattedMarkdownResponse } from '../FormattedMarkdownResponse';

describe('FormattedMarkdownResponse', () => {
  it('renders empty content gracefully', () => {
    render(<FormattedMarkdownResponse content="" />);
    expect(screen.getByText('No content')).toBeInTheDocument();
  });

  it('renders code blocks with language indicator', () => {
    const content = '```javascript\nconst x = 5;\n```';
    const { container } = render(<FormattedMarkdownResponse content={content} />);

    const langSpan = container.querySelector('[class*="uppercase"]');
    expect(langSpan?.textContent).toMatch(/javascript/i);
    expect(screen.getByText('const x = 5;')).toBeInTheDocument();
  });

  it('renders code blocks without language', () => {
    const content = '```\ncode here\n```';
    const { container } = render(<FormattedMarkdownResponse content={content} />);

    const langSpan = container.querySelector('[class*="uppercase"]');
    expect(langSpan?.textContent).toMatch(/code/i);
    expect(screen.getByText('code here')).toBeInTheDocument();
  });

  it('handles copy code button', () => {
    const content = '```python\nprint("hello")\n```';
    render(<FormattedMarkdownResponse content={content} />);

    const copyBtn = screen.getByText('Copy Code');
    fireEvent.click(copyBtn);

    expect(screen.getByText(/copied/i)).toBeInTheDocument();
  });

  it('renders headers correctly', () => {
    const content = '# Header 1\n## Header 2\n### Header 3';
    render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText('Header 1')).toBeInTheDocument();
    expect(screen.getByText('Header 2')).toBeInTheDocument();
    expect(screen.getByText('Header 3')).toBeInTheDocument();
  });

  it('renders bullet points', () => {
    const content = '* Item 1\n* Item 2\n- Item 3';
    render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  it('renders numbered lists', () => {
    const content = '1. First\n2. Second\n3. Third';
    render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
  });

  it('renders callout boxes for blockquotes', () => {
    const content = '> This is important\n> More details';
    render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText(/This is important/)).toBeInTheDocument();
  });

  it('renders bold and inline code', () => {
    const content = 'This is **bold** and `inline code` here.';
    render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('inline code')).toBeInTheDocument();
  });

  it('renders mixed content correctly', () => {
    const content = `# Setup Guide
* Install dependencies
* Configure settings

\`\`\`bash
npm install
\`\`\`

Recommendation: Follow the guide carefully.`;

    render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText('Setup Guide')).toBeInTheDocument();
    expect(screen.getByText('Install dependencies')).toBeInTheDocument();
    expect(screen.getByText('npm install')).toBeInTheDocument();
  });

  it('handles multiple code blocks', () => {
    const content = '```js\nconst a = 1;\n```\n\n```python\nx = 1\n```';
    const { container } = render(<FormattedMarkdownResponse content={content} />);

    const langSpans = container.querySelectorAll('[class*="uppercase"]');
    const langs = Array.from(langSpans).map(s => s.textContent);
    expect(langs.some(l => l?.match(/js/i))).toBe(true);
    expect(langs.some(l => l?.match(/python/i))).toBe(true);
  });

  it('filters out empty lines', () => {
    const content = 'Line 1\n\n\nLine 2';
    const { container } = render(<FormattedMarkdownResponse content={content} />);

    expect(screen.getByText('Line 1')).toBeInTheDocument();
    expect(screen.getByText('Line 2')).toBeInTheDocument();
  });
});
