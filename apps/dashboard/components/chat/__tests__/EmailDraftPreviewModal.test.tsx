import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmailDraftPreviewModal, parseEmailDraft } from '../EmailDraftPreviewModal';
import type { DraftState } from '../DraftPanel';

describe('parseEmailDraft', () => {
  it('extracts To, Subject, and Body correctly from raw text', () => {
    const raw = `To: alex@example.com
Subject: Meeting follow-up
Hello Alex,
Thanks for chatting today.`;

    const parsed = parseEmailDraft(raw);
    expect(parsed.to).toBe('alex@example.com');
    expect(parsed.subject).toBe('Meeting follow-up');
    expect(parsed.body).toBe('Hello Alex,\nThanks for chatting today.');
  });

  it('uses fallback values when headers are missing', () => {
    const raw = 'Hello team, just checking in on the report.';
    const parsed = parseEmailDraft(raw, 'team@example.com', 'Weekly Report');

    expect(parsed.to).toBe('team@example.com');
    expect(parsed.subject).toBe('Weekly Report');
    expect(parsed.body).toBe(raw);
  });
});

describe('EmailDraftPreviewModal', () => {
  const mockDraft: DraftState = {
    content: `To: partner@acme.com
Subject: Strategic Partnership Proposal

Dear Partner,
We are excited to discuss the proposed collaboration.`,
    version: 1,
  };

  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    draft: mockDraft,
    onRevised: jest.fn(),
    onAccept: jest.fn(),
    onSendNow: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockImplementation(() => Promise.resolve()),
      },
    });
  });

  it('does not render when isOpen is false', () => {
    render(<EmailDraftPreviewModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Email Preview')).not.toBeInTheDocument();
  });

  it('renders modal with email preview information when isOpen is true', () => {
    render(<EmailDraftPreviewModal {...defaultProps} />);

    expect(screen.getByText('Email Preview')).toBeInTheDocument();
    expect(screen.getByText('partner@acme.com')).toBeInTheDocument();
    expect(screen.getByText('Strategic Partnership Proposal')).toBeInTheDocument();
    expect(screen.getByText(/We are excited to discuss/)).toBeInTheDocument();
    expect(screen.getByText('DareX AI Executive Assistant')).toBeInTheDocument();
  });

  it('switches between Preview and Edit mode', () => {
    render(<EmailDraftPreviewModal {...defaultProps} />);

    // Click Edit tab
    const editTab = screen.getByRole('button', { name: /edit/i });
    fireEvent.click(editTab);

    // In edit mode, text inputs / textareas should appear
    const textarea = screen.getByPlaceholderText('Write or edit email content...');
    expect(textarea).toBeInTheDocument();

    // Type new body text
    fireEvent.change(textarea, { target: { value: 'Updated content body' } });
    expect(defaultProps.onRevised).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Updated content body'),
      })
    );
  });

  it('calls onClose when close button is clicked', () => {
    render(<EmailDraftPreviewModal {...defaultProps} />);

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onAccept and closes when Accept Draft is clicked', () => {
    render(<EmailDraftPreviewModal {...defaultProps} />);

    const acceptBtn = screen.getByRole('button', { name: /accept draft/i });
    fireEvent.click(acceptBtn);
    expect(defaultProps.onAccept).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onSendNow and closes when Send Now is clicked', () => {
    render(<EmailDraftPreviewModal {...defaultProps} />);

    const sendBtn = screen.getByRole('button', { name: /send now/i });
    fireEvent.click(sendBtn);
    expect(defaultProps.onSendNow).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('copies email text to clipboard when Copy Email is clicked', () => {
    render(<EmailDraftPreviewModal {...defaultProps} />);

    const copyBtn = screen.getByRole('button', { name: /copy email/i });
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('partner@acme.com')
    );
  });
});
