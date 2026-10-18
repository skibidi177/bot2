import { describe, expect, it } from 'vitest';
import { PayOsProvider } from '../../src/payments/payos.js';

// Fixture copied verbatim from https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/
const CHECKSUM_KEY = '1a54716c8f0efb2744fb28b6e38b25da7f67a925d98bc1c18bd8faaecadd7675';
const WEBHOOK_DATA = {
  orderCode: 123,
  amount: 3000,
  description: 'VQRIO123',
  accountNumber: '12345678',
  reference: 'TF230204212323',
  transactionDateTime: '2023-02-04 18:25:00',
  currency: 'VND',
  paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
  code: '00',
  desc: 'Thành công',
  counterAccountBankId: '',
  counterAccountBankName: '',
  counterAccountName: '',
  counterAccountNumber: '',
  virtualAccountName: '',
  virtualAccountNumber: '',
};
const EXPECTED_SIGNATURE = '412e915d2871504ed31be63c8f62a149a4410d34c4c42affc9006ef9917eaa03';

function provider() {
  return new PayOsProvider({
    clientId: 'client',
    apiKey: 'key',
    checksumKey: CHECKSUM_KEY,
    returnUrl: 'http://localhost/return',
    cancelUrl: 'http://localhost/cancel',
  });
}

describe('PayOS webhook signature (official docs vector)', () => {
  it('recomputes the documented signature exactly', () => {
    expect(provider().signWebhookData(WEBHOOK_DATA)).toBe(EXPECTED_SIGNATURE);
  });

  it('accepts a correctly signed webhook payload', () => {
    const body = Buffer.from(JSON.stringify({ code: '00', desc: 'success', success: true, data: WEBHOOK_DATA, signature: EXPECTED_SIGNATURE }));
    const res = provider().parseWebhook(body, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.signatureStatus).toBe('valid');
      expect(res.payment.amount).toBe(3000);
      expect(res.payment.orderCode).toBe(123);
      expect(res.payment.status).toBe('success');
      expect(res.payment.providerRef).toBe('TF230204212323');
    }
  });

  it('rejects tampered payloads', () => {
    const tampered = { ...WEBHOOK_DATA, amount: 999999 };
    const body = Buffer.from(JSON.stringify({ code: '00', desc: 'success', success: true, data: tampered, signature: EXPECTED_SIGNATURE }));
    const res = provider().parseWebhook(body, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.signatureStatus).toBe('invalid');
  });

  it('rejects payloads without signature', () => {
    const body = Buffer.from(JSON.stringify({ code: '00', desc: 'success', success: true, data: WEBHOOK_DATA }));
    const res = provider().parseWebhook(body, {});
    expect(res.ok).toBe(false);
  });
});
