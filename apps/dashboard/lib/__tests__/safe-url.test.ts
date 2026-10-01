/**
 * @jest-environment node
 *
 * Attachment links must be http(s) only (CH-S04).
 */
import { safeHttpUrl } from '@/lib/safe-url';

describe('safeHttpUrl', () => {
  it('keeps http and https URLs', () => {
    expect(safeHttpUrl('https://cdn.example.com/a.pdf')).toBe('https://cdn.example.com/a.pdf');
    expect(safeHttpUrl('  http://example.com/x ')).toBe('http://example.com/x');
  });

  it('rejects script, data and other schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHttpUrl(' \tjavascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects relative, empty and non-string values', () => {
    expect(safeHttpUrl('/api/files/1')).toBeNull();
    expect(safeHttpUrl('//evil.example.com')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});
