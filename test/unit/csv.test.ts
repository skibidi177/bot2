import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/core/csv.js';

describe('csv parser', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles CRLF, quoted commas and escaped quotes', () => {
    const csv = 'sku,secret\r\nACC-1,"key,with,commas"\r\nACC-2,"say ""hi"""\r\n';
    expect(parseCsv(csv)).toEqual([
      ['sku', 'secret'],
      ['ACC-1', 'key,with,commas'],
      ['ACC-2', 'say "hi"'],
    ]);
  });

  it('keeps multiline quoted fields', () => {
    expect(parseCsv('secret\n"line1\nline2"\n')).toEqual([['secret'], ['line1\nline2']]);
  });

  it('ignores trailing empty line', () => {
    expect(parseCsv('a\nb\n\n')).toEqual([['a'], ['b']]);
  });
});
