'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mail,
  X,
  Copy,
  Check,
  Send,
  Sparkles,
  Edit3,
  Eye,
  RotateCcw,
  CornerDownLeft,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import type { DraftState } from './DraftPanel';

interface EmailDraftPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  draft: DraftState;
  planId?: string;
  senderEmail?: string;
  recipientEmail?: string;
  subject?: string;
  onRevised?: (draft: DraftState, newStatus?: string) => void;
  onAccept?: () => void;
  onSendNow?: () => void;
}

export interface ParsedEmail {
  to: string;
  subject: string;
  body: string;
}

export function parseEmailDraft(
  rawContent: string,
  fallbackTo?: string,
  fallbackSubject?: string
): ParsedEmail {
  const lines = rawContent.split('\n');
  let to = fallbackTo || '';
  let subject = fallbackSubject || '';
  const bodyLines: string[] = [];

  let inHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inHeader) {
      const toMatch = trimmed.match(/^to:\s*(.+)$/i);
      if (toMatch) {
        to = toMatch[1].trim();
        continue;
      }

      const subjectMatch = trimmed.match(/^subject:\s*(.+)$/i);
      if (subjectMatch) {
        subject = subjectMatch[1].trim();
        continue;
      }

      const fromMatch = trimmed.match(/^from:\s*(.+)$/i);
      if (fromMatch) {
        // Skip explicit from headers in body
        continue;
      }

      // If we encounter an empty line after finding headers, or normal text starts
      if (trimmed === '') {
        if (to || subject) {
          inHeader = false;
          continue;
        }
      } else {
        inHeader = false;
        bodyLines.push(line);
        continue;
      }
    } else {
      bodyLines.push(line);
    }
  }

  const cleanBody = bodyLines.length > 0 ? bodyLines.join('\n').trim() : rawContent.trim();

  if (!subject) {
    // Generate a reasonable default subject if none provided
    subject = 'Follow-up from DareX Executive';
  }

  return {
    to: to || fallbackTo || 'client@company.com',
    subject,
    body: cleanBody,
  };
}

export const EmailDraftPreviewModal: React.FC<EmailDraftPreviewModalProps> = ({
  isOpen,
  onClose,
  draft,
  planId,
  senderEmail = 'executive@darex.ai',
  recipientEmail,
  subject: initialSubject,
  onRevised,
  onAccept,
  onSendNow,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'edit'>('preview');
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parsed email pieces
  const parsed = parseEmailDraft(draft.content, recipientEmail, initialSubject);
  const [currentTo, setCurrentTo] = useState(parsed.to);
  const [currentSubject, setCurrentSubject] = useState(parsed.subject);
  const [currentBody, setCurrentBody] = useState(parsed.body);

  // Sync when draft content updates from outside
  useEffect(() => {
    const p = parseEmailDraft(draft.content, recipientEmail, initialSubject);
    setCurrentTo(p.to);
    setCurrentSubject(p.subject);
    setCurrentBody(p.body);
  }, [draft.content, recipientEmail, initialSubject]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopy = () => {
    const fullEmailText = `To: ${currentTo}\nSubject: ${currentSubject}\n\n${currentBody}`;
    navigator.clipboard.writeText(fullEmailText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleBodyChange = (newBody: string) => {
    setCurrentBody(newBody);
    const updatedFullContent = `To: ${currentTo}\nSubject: ${currentSubject}\n\n${newBody}`;
    onRevised?.({ ...draft, content: updatedFullContent });
  };

  const handleSubjectChange = (newSubject: string) => {
    setCurrentSubject(newSubject);
    const updatedFullContent = `To: ${currentTo}\nSubject: ${newSubject}\n\n${currentBody}`;
    onRevised?.({ ...draft, content: updatedFullContent });
  };

  const handleToChange = (newTo: string) => {
    setCurrentTo(newTo);
    const updatedFullContent = `To: ${newTo}\nSubject: ${currentSubject}\n\n${currentBody}`;
    onRevised?.({ ...draft, content: updatedFullContent });
  };

  const handleRevise = async () => {
    if (!feedback.trim() || revising) return;
    setRevising(true);
    setError(null);
    try {
      const res = await fetch('/api/ask-ai/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: planId || '',
          feedback: `Polish this email:\nTo: ${currentTo}\nSubject: ${currentSubject}\nInstruction: ${feedback.trim()}`,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.draft) {
        setFeedback('');
        onRevised?.(data.draft, data.status);
      } else {
        setError(data.error || 'Revision request failed');
      }
    } catch (err: any) {
      setError(err?.message || 'Revision request failed');
    } finally {
      setRevising(false);
    }
  };

  const handleAcceptDraft = () => {
    onAccept?.();
    onClose();
  };

  const handleSend = () => {
    if (onSendNow) {
      onSendNow();
    } else {
      onAccept?.();
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/60 backdrop-blur-xs font-sans overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="email-preview-title"
    >
      {/* Click backdrop to close */}
      <div className="fixed inset-0" onClick={onClose} />

      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="relative w-full max-w-3xl bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] z-10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Window Topbar */}
        <div className="flex items-center justify-between px-4 py-3 bg-slate-100 border-b border-slate-200 shrink-0">
          <div className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full bg-rose-400 border border-rose-500/40 inline-block" />
            <span className="w-3 h-3 rounded-full bg-amber-400 border border-amber-500/40 inline-block" />
            <span className="w-3 h-3 rounded-full bg-emerald-400 border border-emerald-500/40 inline-block" />
            <span className="ml-2 text-xs font-semibold text-slate-700 flex items-center gap-1.5" id="email-preview-title">
              <Mail className="w-3.5 h-3.5 text-amber-600" />
              <span>Email Preview</span>
              <span className="font-mono text-[10px] bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.2 rounded-full font-bold">
                v{draft.version}
              </span>
            </span>
          </div>

          <div className="flex items-center space-x-2">
            {/* View Mode Tabs */}
            <div className="flex items-center bg-slate-200/80 p-0.5 rounded-lg text-[11px] font-medium text-slate-600">
              <button
                type="button"
                onClick={() => setActiveTab('preview')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition-all ${
                  activeTab === 'preview' ? 'bg-white text-slate-800 shadow-xs font-semibold' : 'hover:text-slate-900'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span>Preview</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('edit')}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition-all ${
                  activeTab === 'edit' ? 'bg-white text-slate-800 shadow-xs font-semibold' : 'hover:text-slate-900'
                }`}
              >
                <Edit3 className="w-3 h-3" />
                <span>Edit</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
              title="Close Preview (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Email Header Meta Fields */}
        <div className="px-6 py-3.5 bg-slate-50 border-b border-slate-200 text-xs space-y-2 shrink-0">
          <div className="flex items-center text-slate-500">
            <span className="w-16 font-semibold shrink-0">From:</span>
            <span className="font-mono text-slate-700">{senderEmail}</span>
            <span className="ml-2 text-[10px] text-amber-800 bg-amber-100/70 border border-amber-200 px-1.5 py-0.2 rounded font-medium">
              DareX Executive
            </span>
          </div>

          <div className="flex items-center text-slate-500">
            <span className="w-16 font-semibold shrink-0">To:</span>
            {activeTab === 'edit' ? (
              <input
                type="email"
                value={currentTo}
                onChange={(e) => handleToChange(e.target.value)}
                className="flex-1 px-2 py-0.5 bg-white border border-slate-300 rounded text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-500"
                placeholder="recipient@company.com"
              />
            ) : (
              <span className="font-mono text-slate-800 font-medium">{currentTo}</span>
            )}
          </div>

          <div className="flex items-center text-slate-500">
            <span className="w-16 font-semibold shrink-0">Subject:</span>
            {activeTab === 'edit' ? (
              <input
                type="text"
                value={currentSubject}
                onChange={(e) => handleSubjectChange(e.target.value)}
                className="flex-1 px-2 py-0.5 bg-white border border-slate-300 rounded text-xs text-slate-900 font-semibold focus:outline-none focus:ring-1 focus:ring-amber-500"
                placeholder="Email subject..."
              />
            ) : (
              <span className="text-slate-900 font-semibold text-xs">{currentSubject}</span>
            )}
          </div>
        </div>

        {/* Email Body Viewport */}
        <div className="flex-1 p-6 overflow-y-auto bg-white min-h-[240px]">
          {activeTab === 'preview' ? (
            <div className="prose prose-sm max-w-none text-slate-800 text-xs leading-relaxed space-y-3 font-sans">
              {currentBody.split('\n\n').map((paragraph, idx) => (
                <p key={idx} className="whitespace-pre-line">
                  {paragraph}
                </p>
              ))}

              {/* Professional Email Signature Box */}
              <div className="mt-8 pt-4 border-t border-slate-200/80 text-[11px] text-slate-500 space-y-1">
                <p className="font-semibold text-slate-700">Best regards,</p>
                <p className="font-medium text-slate-800">DareX AI Executive Assistant</p>
                <p className="text-[10px] text-slate-400">Autonomous Organization Intelligence</p>
              </div>
            </div>
          ) : (
            <textarea
              value={currentBody}
              onChange={(e) => handleBodyChange(e.target.value)}
              className="w-full h-full min-h-[220px] p-2 font-mono text-xs text-slate-800 bg-slate-50/50 border border-slate-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none leading-relaxed"
              placeholder="Write or edit email content..."
            />
          )}
        </div>

        {/* Inline AI Revision Box */}
        <div className="px-6 py-2.5 bg-slate-50/90 border-t border-slate-200 shrink-0">
          <div className="relative flex items-center">
            <Sparkles className="w-3.5 h-3.5 text-amber-600 absolute left-2.5 pointer-events-none" />
            <input
              type="text"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRevise()}
              placeholder="Request AI revision (e.g., 'Make it more professional', 'Shorten paragraph 2')..."
              disabled={revising}
              className="w-full pl-8 pr-8 py-2 bg-white border border-slate-300 rounded-xl text-[11px] text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleRevise}
              disabled={!feedback.trim() || revising}
              className="absolute right-2 p-1 text-amber-600 hover:text-amber-800 disabled:opacity-30"
              title="Submit revision"
            >
              {revising ? <RotateCcw className="w-3.5 h-3.5 animate-spin" /> : <CornerDownLeft className="w-3.5 h-3.5" />}
            </button>
          </div>
          {error && <div className="mt-1 text-[10px] text-rose-600">{error}</div>}
        </div>

        {/* Modal Footer Controls */}
        <div className="flex items-center justify-between px-6 py-3.5 bg-white border-t border-slate-200 shrink-0 gap-3">
          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl border border-slate-200 flex items-center gap-1.5 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied' : 'Copy Email'}</span>
          </button>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-600 text-xs font-semibold rounded-xl border border-slate-300 transition-colors"
            >
              Close
            </button>

            <button
              type="button"
              onClick={handleAcceptDraft}
              className="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-semibold rounded-xl border border-amber-300 flex items-center gap-1.5 transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-amber-700" />
              <span>Accept Draft</span>
            </button>

            <button
              type="button"
              onClick={handleSend}
              className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 shadow-xs transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send Now</span>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
