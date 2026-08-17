import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DraftPanel, DraftState } from '../DraftPanel';

describe('DraftPanel', () => {
  const mockDraft: DraftState = {
    content: 'This is the draft content.',
    version: 1,
    accepted: false,
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders draft content', () => {
    render(<DraftPanel draft={mockDraft} planId="plan-1" onRevised={jest.fn()} />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText(mockDraft.content)).toBeInTheDocument();
  });

  it('shows accepted badge when draft is accepted', () => {
    render(
      <DraftPanel
        draft={{ ...mockDraft, accepted: true }}
        planId="plan-1"
        onRevised={jest.fn()}
      />
    );

    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });

  it('handles regenerate action', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        draft: { ...mockDraft, version: 2, content: 'Regenerated content' },
      }),
    });

    const onRevised = jest.fn();
    render(<DraftPanel draft={mockDraft} planId="plan-1" onRevised={onRevised} />);

    const regenerateBtn = screen.getByText('Regenerate');
    fireEvent.click(regenerateBtn);

    await waitFor(() => {
      expect(onRevised).toHaveBeenCalled();
    });
  });

  it('handles feedback submission', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        draft: { ...mockDraft, version: 2 },
      }),
    });

    const onRevised = jest.fn();
    render(<DraftPanel draft={mockDraft} planId="plan-1" onRevised={onRevised} />);

    const input = screen.getByPlaceholderText(/Leave feedback/i);
    fireEvent.change(input, { target: { value: 'Please improve this' } });

    const submitBtn = screen.getByText('Request changes');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  it('handles accept action', () => {
    const onRevised = jest.fn();
    const onAccept = jest.fn();
    render(
      <DraftPanel
        draft={mockDraft}
        planId="plan-1"
        onRevised={onRevised}
        onAccept={onAccept}
      />
    );

    const acceptBtn = screen.getByText(/^Accept$/);
    fireEvent.click(acceptBtn);

    expect(onAccept).toHaveBeenCalled();
    expect(onRevised).toHaveBeenCalledWith(expect.objectContaining({ accepted: true }));
  });

  it('clears feedback after submission', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        draft: { ...mockDraft, version: 2 },
      }),
    });

    const onRevised = jest.fn();
    render(<DraftPanel draft={mockDraft} planId="plan-1" onRevised={onRevised} />);

    const input = screen.getByPlaceholderText(/Leave feedback/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Please improve this' } });

    expect(input.value).toBe('Please improve this');

    const submitBtns = screen.getAllByText('Request changes');
    const submitBtn = submitBtns[submitBtns.length - 1];
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  it('edits draft content when editable', () => {
    const onRevised = jest.fn();
    render(
      <DraftPanel
        draft={mockDraft}
        planId="plan-1"
        editable
        onRevised={onRevised}
      />
    );

    const textarea = screen.getByDisplayValue(mockDraft.content) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'New content' } });

    expect(onRevised).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'New content' })
    );
  });

  it('shows error message on revision failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Revision failed' }),
    });

    const onRevised = jest.fn();
    render(<DraftPanel draft={mockDraft} planId="plan-1" onRevised={onRevised} />);

    const input = screen.getByPlaceholderText(/Leave feedback/i);
    fireEvent.change(input, { target: { value: 'Please improve this' } });

    const submitBtn = screen.getByText('Request changes');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Revision failed')).toBeInTheDocument();
    });
  });

  it('supports keyboard submit via Enter key', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, draft: mockDraft }),
    });

    const onRevised = jest.fn();
    render(<DraftPanel draft={mockDraft} planId="plan-1" onRevised={onRevised} />);

    const input = screen.getByPlaceholderText(/Leave feedback/i);
    fireEvent.change(input, { target: { value: 'Please improve this' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
