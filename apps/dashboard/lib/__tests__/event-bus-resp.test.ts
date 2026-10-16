import { consumeRespFrames, encodeCommand, parseResp } from '../event-bus';

describe('event-bus RESP framing', () => {
  it('parses a bulk string split across TCP chunks', () => {
    const full = Buffer.from('$11\r\nhello world\r\n');
    const mid = 8;
    const first = full.subarray(0, mid);
    const second = full.subarray(mid);

    let buf = Buffer.from(first);
    let drained = consumeRespFrames(buf);
    expect(drained.values).toHaveLength(0);
    expect(drained.rest.equals(first)).toBe(true);

    buf = Buffer.concat([drained.rest, second]);
    drained = consumeRespFrames(buf);
    expect(drained.values).toEqual(['hello world']);
    expect(drained.rest.length).toBe(0);
  });

  it('parses an array whose elements arrive in separate chunks', () => {
    const full = Buffer.concat([
      Buffer.from('*3\r\n'),
      Buffer.from('$7\r\nmessage\r\n'),
      Buffer.from('$10\r\norg:acme-1\r\n'),
      Buffer.from('$5\r\nhello\r\n'),
    ]);

    const cuts = [2, 10, 22, 36];
    let rest = Buffer.alloc(0);
    const values: unknown[] = [];
    let prev = 0;
    for (const cut of [...cuts, full.length]) {
      rest = Buffer.concat([rest, full.subarray(prev, cut)]);
      prev = cut;
      const drained = consumeRespFrames(rest);
      values.push(...drained.values);
      rest = Buffer.from(drained.rest);
    }
    expect(values).toEqual([['message', 'org:acme-1', 'hello']]);
    expect(rest.length).toBe(0);
  });

  it('encodeCommand round-trips through parseResp', () => {
    const encoded = encodeCommand(['PUBLISH', 'org:x', '{"type":"ping"}']);
    const pos = { i: 0 };
    const value = parseResp(encoded, pos);
    expect(value).toEqual(['PUBLISH', 'org:x', '{"type":"ping"}']);
    expect(pos.i).toBe(encoded.length);
  });
});
