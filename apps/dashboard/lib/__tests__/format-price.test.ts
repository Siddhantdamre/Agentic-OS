import { formatPrice } from '../format-price';

describe('formatPrice', () => {
  it('groups rupees the way they are written in India', () => {
    expect(formatPrice(8500000, 'INR')).toBe('₹85,00,000');
    expect(formatPrice('8500000', 'INR')).toBe('₹85,00,000');
    expect(formatPrice(12500000, 'INR')).toBe('₹1,25,00,000');
  });

  it('shows other currencies with their own symbol and grouping', () => {
    expect(formatPrice(250000, 'USD')).toBe('$250,000');
    expect(formatPrice(1200, 'AED')).toMatch(/1,200/);
  });

  it('shows a dash when there is no price', () => {
    expect(formatPrice(null, 'INR')).toBe('—');
    expect(formatPrice('', 'INR')).toBe('—');
    expect(formatPrice(undefined, 'INR')).toBe('—');
  });

  it('keeps words such as "On request" and never prints NaN', () => {
    expect(formatPrice('On request', 'INR')).toBe('On request');
    expect(formatPrice('abc', 'INR')).toBe('abc');
  });

  it('copes with an unknown currency code instead of throwing', () => {
    expect(() => formatPrice(1000, 'ZZZZ')).not.toThrow();
    expect(formatPrice(1000, 'ZZZZ')).toMatch(/1,000/);
  });

  it('assumes rupees when no currency is given', () => {
    expect(formatPrice(500000)).toBe('₹5,00,000');
  });
});
