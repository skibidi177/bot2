import { hmacSha256Hex, timingSafeEqualHex } from '../core/crypto.js';
import type { OrderRow } from '../db/types.js';
import { buildVietQrString, vietQrPng } from './vietqr.js';
import type { BankConfig } from './manual.js';
import type { NormalizedPayment, PaymentDraft, PaymentProvider, WebhookParseResult } from './types.js';

/**
 * Mock provider for TEST / STAGING ONLY. Refuses to be constructed in
 * production (enforced in config + registry). It renders a real VietQR so the
 * buyer flow can be exercised, and exposes a webhook endpoint protected by an
 * HMAC shared secret so only someone holding MOCK_WEBHOOK_SECRET can confirm
 * a payment — simulated confirmations are always labelled provider=mock.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly automated = true;
  constructor(
    private readonly secret: string,
    private readonly bank: BankConfig,
  ) {}

  async createPayment(order: OrderRow, transferCode: string): Promise<PaymentDraft> {
    const qrString = buildVietQrString({
      bin: this.bank.bin,
      accountNumber: this.bank.accountNumber,
      accountName: this.bank.accountName,
      amount: order.total,
      message: transferCode,
    });
    const qrPng = await vietQrPng(qrString);
    return {
      qrString,
      qrPng,
      checkoutUrl: null,
      providerRef: null,
      instructions:
        `[MÔI TRƯỜNG TEST] Quét QR giả lập hoặc gọi POST /webhooks/payments/mock với chữ ký HMAC.\nNội dung: ${transferCode}`,
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookParseResult {
    const signature = headers['x-mock-signature'] ?? '';
    const expected = hmacSha256Hex(this.secret, rawBody);
    let parsed: { orderCode?: number; amount?: number; reference?: string; status?: string };
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, signatureStatus: 'none', reason: 'invalid_json', raw: {}, providerEventId: 'unparseable' };
    }
    const eventId = String(parsed.reference ?? `mock-${String(parsed.orderCode ?? 0)}-${String(parsed.amount ?? 0)}`);
    if (!signature || !timingSafeEqualHex(expected, signature)) {
      return { ok: false, signatureStatus: 'invalid', reason: 'bad_signature', raw: parsed as Record<string, unknown>, providerEventId: eventId };
    }
    const payment: NormalizedPayment = {
      providerEventId: eventId,
      providerRef: String(parsed.reference ?? eventId),
      orderCode: parsed.orderCode ?? null,
      amount: Number(parsed.amount ?? 0),
      status: parsed.status === 'failed' ? 'failed' : 'success',
      counterAccount: '0000000000',
      counterAccountName: 'MOCK PAYER',
      paidAt: new Date(),
      raw: parsed as Record<string, unknown>,
    };
    return { ok: true, signatureStatus: 'valid', payment };
  }
}
