import { describe, expect, it } from 'vitest';
import { buildVietQrString, crc16ccitt, parseEmv, verifyVietQrCrc } from '../../src/payments/vietqr.js';

// Real production VietQR payload decoded from the reference QR image attached to the project brief.
const REFERENCE_STATIC =
  '00020101021138540010A00000072701240006970418011088755057860208QRIBFTTA53037045802VN63046068';

describe('VietQR EMV builder', () => {
  it('reproduces the decoded reference QR byte-for-byte (static, no amount/message)', () => {
    const built = buildVietQrString({ bin: '970418', accountNumber: '8875505786', accountName: 'HOANG HUE QUYNH' });
    expect(built).toBe(REFERENCE_STATIC);
  });

  it('reference sample carries a valid CRC16-CCITT check value', () => {
    expect(verifyVietQrCrc(REFERENCE_STATIC)).toBe(true);
    expect(crc16ccitt('123456789')).toBe('29B1'); // CRC-16/CCITT-FALSE check value (EMV)
  });

  it('builds dynamic QR with amount + transfer content and parses back', () => {
    const built = buildVietQrString({
      bin: '970418',
      accountNumber: '8875505786',
      accountName: 'HOANG HUE QUYNH',
      amount: 50000,
      message: 'M100042',
    });
    expect(verifyVietQrCrc(built)).toBe(true);
    const tags = parseEmv(built);
    expect(tags.get('01')).toBe('12'); // dynamic
    expect(tags.get('54')).toBe('50000');
    const merchant = parseEmv(tags.get('38')!);
    expect(merchant.get('00')).toBe('A000000727');
    const inner = parseEmv(merchant.get('01')!);
    expect(inner.get('00')).toBe('970418');
    expect(inner.get('01')).toBe('8875505786');
    expect(merchant.get('02')).toBe('QRIBFTTA');
    const extra = parseEmv(tags.get('62')!);
    expect(extra.get('08')).toBe('M100042');
    expect(tags.get('53')).toBe('704');
    expect(tags.get('58')).toBe('VN');
  });

  it('rejects malformed bank input', () => {
    expect(() => buildVietQrString({ bin: '123', accountNumber: '123456', accountName: 'X' })).toThrow();
    expect(() => buildVietQrString({ bin: '970418', accountNumber: '123', accountName: 'X' })).toThrow();
  });
});
