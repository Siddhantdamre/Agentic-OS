import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// Unmock OpenUiFenceBlock for its own unit tests
jest.unmock('../OpenUiFenceBlock');
jest.unmock('@/components/chat/OpenUiFenceBlock');

// Mock @openuidev/react-lang and @openuidev/react-ui to test OpenUiFenceBlock behavior
jest.mock('@openuidev/react-lang', () => ({
  Renderer: ({ response, isStreaming }: { response: string; isStreaming?: boolean }) => (
    <div data-testid="mock-openui-renderer">
      <span>{response}</span>
      {isStreaming && <span data-testid="mock-streaming">Streaming...</span>}
    </div>
  ),
}));

jest.mock('@openuidev/react-ui', () => ({
  ThemeProvider: ({
    mode,
    children,
    cssSelector,
  }: {
    mode: string;
    children: React.ReactNode;
    cssSelector?: string;
  }) => (
    <div data-testid="mock-theme-provider" data-theme-mode={mode} data-css-selector={cssSelector}>
      {children}
    </div>
  ),
  openuiLibrary: {},
}));

import { OpenUiFenceBlock } from '../OpenUiFenceBlock';

describe('OpenUiFenceBlock', () => {
  it('renders nothing when content is empty', () => {
    const { container } = render(<OpenUiFenceBlock content="" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders in light mode by default with synchronized ThemeProvider and light styling', () => {
    const content = 'root = TextContent("Hello Darex")';
    render(<OpenUiFenceBlock content={content} />);

    expect(screen.getByText('Interactive OpenUI Widget')).toBeInTheDocument();
    expect(screen.getByText('Dark')).toBeInTheDocument();
    expect(screen.getByText('View Code')).toBeInTheDocument();

    const themeProvider = screen.getByTestId('mock-theme-provider');
    expect(themeProvider).toHaveAttribute('data-theme-mode', 'light');

    const renderer = screen.getByTestId('mock-openui-renderer');
    expect(renderer).toHaveTextContent('root = TextContent("Hello Darex")');

    // Scoped container has openui-light class
    const scopeDiv = themeProvider.querySelector('.markdown-openui-scope');
    expect(scopeDiv).toHaveClass('openui-light');
    expect(scopeDiv).toHaveClass('text-slate-900');
  });

  it('toggles theme between light and dark synchronously', () => {
    const content = 'root = TextContent("Metrics Dashboard")';
    render(<OpenUiFenceBlock content={content} />);

    const themeToggleBtn = screen.getByRole('button', { name: /switch to dark widget theme/i });
    expect(themeToggleBtn).toBeInTheDocument();

    // Toggle to Dark
    fireEvent.click(themeToggleBtn);

    const themeProviderDark = screen.getByTestId('mock-theme-provider');
    expect(themeProviderDark).toHaveAttribute('data-theme-mode', 'dark');

    const scopeDivDark = themeProviderDark.querySelector('.markdown-openui-scope');
    expect(scopeDivDark).toHaveClass('openui-dark');
    expect(scopeDivDark).toHaveClass('text-slate-100');

    expect(screen.getByText('Light')).toBeInTheDocument();

    // Toggle back to Light
    const lightToggleBtn = screen.getByRole('button', { name: /switch to light widget theme/i });
    fireEvent.click(lightToggleBtn);

    const themeProviderLight = screen.getByTestId('mock-theme-provider');
    expect(themeProviderLight).toHaveAttribute('data-theme-mode', 'light');
  });

  it('toggles between widget view and raw code view', () => {
    const content = 'root = TextContent("Chart Spec")';
    render(<OpenUiFenceBlock content={content} />);

    const viewCodeBtn = screen.getByRole('button', { name: /view code/i });
    fireEvent.click(viewCodeBtn);

    expect(screen.getByText('Show Widget')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-openui-renderer')).not.toBeInTheDocument();

    // Toggle back to widget
    const showWidgetBtn = screen.getByRole('button', { name: /show widget/i });
    fireEvent.click(showWidgetBtn);

    expect(screen.getByTestId('mock-openui-renderer')).toBeInTheDocument();
  });

  it('renders streaming indicator when isStreaming is true', () => {
    const content = 'root = TextContent("Streaming content")';
    render(<OpenUiFenceBlock content={content} isStreaming={true} />);

    expect(screen.getByText('Streaming')).toBeInTheDocument();
    expect(screen.getByTestId('mock-streaming')).toBeInTheDocument();
  });

  it('initializes in dark mode when darkTheme prop is true', () => {
    const content = 'root = TextContent("Dark Mode Widget")';
    render(<OpenUiFenceBlock content={content} darkTheme={true} />);

    const themeProvider = screen.getByTestId('mock-theme-provider');
    expect(themeProvider).toHaveAttribute('data-theme-mode', 'dark');

    const scopeDiv = themeProvider.querySelector('.markdown-openui-scope');
    expect(scopeDiv).toHaveClass('openui-dark');
    expect(scopeDiv).toHaveClass('text-slate-100');
  });
});
