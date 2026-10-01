import '@testing-library/jest-dom'

if (typeof TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}

const { webcrypto } = require('crypto');
Object.defineProperty(global, 'crypto', {
  value: webcrypto,
  writable: true,
  configurable: true,
});

Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn(() => Promise.resolve()),
  },
})

jest.mock('@/components/chat/OpenUiFenceBlock', () => ({
  OpenUiFenceBlock: ({ content }) => <div data-testid="openui-widget">{content}</div>,
}))
jest.mock('./components/chat/OpenUiFenceBlock', () => ({
  OpenUiFenceBlock: ({ content }) => <div data-testid="openui-widget">{content}</div>,
}))

