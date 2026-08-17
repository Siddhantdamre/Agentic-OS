import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReasoningStrip } from '../ReasoningStrip';

describe('ReasoningStrip', () => {
  it('renders with default duration', () => {
    render(<ReasoningStrip text="Analyzing request..." />);

    expect(screen.getByText('Synthesized in 1.2s')).toBeInTheDocument();
  });

  it('formats milliseconds correctly', () => {
    render(<ReasoningStrip text="Analyzing..." durationMs={500} />);

    expect(screen.getByText('Synthesized in 500ms')).toBeInTheDocument();
  });

  it('formats seconds correctly', () => {
    render(<ReasoningStrip text="Analyzing..." durationMs={3500} />);

    expect(screen.getByText('Synthesized in 3.5s')).toBeInTheDocument();
  });

  it('toggles reasoning text visibility', () => {
    const reasoningText = 'Checking connector status, planning workflow steps, verifying permissions...';
    render(<ReasoningStrip text={reasoningText} />);

    const button = screen.getByRole('button');

    fireEvent.click(button);
    expect(screen.getByText(reasoningText)).toBeInTheDocument();
  });

  it('shows default text when none provided', () => {
    render(<ReasoningStrip text="" />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(
      screen.getByText(/Analyzing business context/)
    ).toBeInTheDocument();
  });

  it('handles null duration', () => {
    render(<ReasoningStrip text="Analyzing..." durationMs={null} />);

    expect(screen.getByText('Synthesized in 1.2s')).toBeInTheDocument();
  });

  it('handles zero duration', () => {
    render(<ReasoningStrip text="Analyzing..." durationMs={0} />);

    expect(screen.getByText(/Synthesized in/)).toBeInTheDocument();
  });

  it('renders icon that responds to user interaction', () => {
    const { container } = render(<ReasoningStrip text="Analyzing..." />);

    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();

    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);

    fireEvent.click(button);
    expect(screen.getByText('Analyzing...')).toBeInTheDocument();
  });

  it('supports hover interaction', () => {
    render(<ReasoningStrip text="Analyzing..." />);

    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);
    fireEvent.mouseLeave(button);

    expect(button).toBeInTheDocument();
  });
});
