import { visibleAnswer } from './tool-answer';

const fenced = `\n<untrusted_tool_data>\n${JSON.stringify({
  status: 'executed',
  message: 'Found 1',
  data: {
    query: 'darexai founders',
    results: [
      {
        title: 'Sanu Shaurya - Founder',
        url: 'https://in.linkedin.com/in/sanu',
        snippet: 'Founder @DarexAI',
      },
    ],
  },
})}\n</untrusted_tool_data>\n`;

describe('visibleAnswer', () => {
  it('hides wikipedia pages that never mention the company', () => {
    const raw = JSON.stringify({
      status: 'executed',
      message: 'Found 5 live web search results',
      data: {
        query: 'DareX AI founder OR DareX founders',
        results: [
          { title: 'Diomedes', url: 'https://en.wikipedia.org/wiki/Diomedes', snippet: 'Greek hero who punished Achilles' },
          { title: 'Sanu Shaurya - Founder @DarexAI', url: 'https://in.linkedin.com/in/sanu', snippet: 'Founder at DarexAI' },
        ],
      },
    });
    const text = visibleAnswer('I was unable to find any information.', [
      { toolUsed: 'web_search', result: raw },
    ]);
    expect(text).not.toContain('Diomedes');
    expect(text).toContain('Sanu Shaurya');
    expect(text).toContain('named as a founder');
  });

  it('replaces a denial with the pages that were actually inside the tool fence', () => {
    const text = visibleAnswer(
      'I was unable to find any information about the founders of DareX AI.',
      [{ action: 'web_search', observation: fenced }],
    );
    expect(text).toContain('Sanu Shaurya');
    expect(text).not.toContain('untrusted_tool_data');
    expect(text).not.toContain('unable to find');
    expect(text).not.toContain('Diomedes');
  });

  it('reads pages nested in an error content block', () => {
    const nested = JSON.stringify({
      error: [{ type: 'text', text: fenced }],
    });
    const text = visibleAnswer('I have completed the task.', [
      { toolUsed: 'web_search', result: nested },
    ]);
    expect(text).toContain('Sanu Shaurya');
    expect(text).not.toContain('[object Object]');
  });

  it('answers a founder question from company pages without naming a different Darex', () => {
    const raw = JSON.stringify({
      status: 'executed',
      data: {
        query: 'Darex AI founders',
        results: [
          { title: 'Darex AI', url: 'https://darexai.com', snippet: 'Darex AI builds AI automation and voice agents.' },
          { title: 'DareX Solutions', url: 'https://darex-solutions.com', snippet: 'Boutique web development studio.' },
          { title: 'Darex AI - Tracxn', url: 'https://tracxn.com/d/companies/darex-ai', snippet: 'Darex AI is an unfunded company, founded in 2025.' },
        ],
      },
    });
    const text = visibleAnswer('The matching pages are listed with the search above.', [
      { toolUsed: 'web_search', result: raw },
    ]);
    expect(text).toContain('None of these pages name an individual founder');
    expect(text).toContain('founded in 2025');
    expect(text).toContain('voice agents');
    expect(text).not.toContain('DareX Solutions');
    expect(text).not.toContain('matching pages');
  });

  it('turns an unsigned connector into a connect link and keeps the rest of the answer', () => {
    const text = visibleAnswer('Gmail is not signed in. Connect it at /connectors. The sheet total is 12.', []);
    expect(text).toContain('[Sign in](/connectors?connect=gmail)');
    expect(text).toContain('sheet total is 12');
  });

  it('keeps a specific connect path on the reply link', () => {
    const text = visibleAnswer('Sheets is not signed in. Re-authorize at /connectors?connect=google-sheets.', []);
    expect(text).toContain('[Sign in](/connectors?connect=google-sheets)');
  });

  it('leaves a generic connectors link when several accounts are unsigned', () => {
    const text = visibleAnswer('Gmail and Slack are not signed in. Connect them at /connectors.', []);
    expect(text).toContain('[Connectors](/connectors)');
    expect(text).not.toContain('?connect=');
  });

  it('does not claim a search finished when the placeholder had no search steps', () => {
    const text = visibleAnswer('I have completed the task.', []);
    expect(text).not.toMatch(/search finished/i);
    expect(text).toContain('I have completed the task');
  });

  it('says the web was not checked when every search provider failed', () => {
    const raw = JSON.stringify({
      status: 'error',
      message: 'Web search is unavailable right now (provider_unavailable)',
      data: { query: 'acme funding', results: [], reason: 'provider_unavailable' },
    });
    const text = visibleAnswer('I could not find any results for that.', [{ toolUsed: 'web_search', result: raw }]);
    expect(text).toMatch(/couldn't check the web for “acme funding”/);
    expect(text).not.toMatch(/none of the pages/);
  });
});
