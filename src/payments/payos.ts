import { hmacSha256Hex, timingSafeEqualHex } from '../core/crypto.js';
import { PaymentVerificationError } from '../core/errors.js';
import type { OrderRow } from '../db/types.js';
import type { NormalizedPayment, PaymentDraft, PaymentProvider, WebhookParseResult } from './types.js';

export interface PayOsConfig {
  clientId: string;
  apiKey: string;
  checksumKey: string;
  baseUrl?: string;
  returnUrl: string;
  cancelUrl: string;
}

/**
 * PayOS payment gateway adapter.
 * Implemented against the official API docs (https://payos.vn/docs/api/):
 *  - POST {baseUrl}/v2/payment-requests with headers x-client-id / x-api-key
 *  - request signature = HMAC_SHA256(checksumKey, "amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..")
 *    (keys sorted alphabetically)
 *  - webhook body { code, desc, success, data{...}, signature } where signature is
 *    HMAC_SHA256(checksumKey, data serialized as key=value&... sorted alphabetically,
 *    null/undefined as empty string)
 */
export class PayOsProvider implements PaymentProvider {
  readonly name = 'payos';
  readonly automated = true;
  constructor(private readonly cfg: PayOsConfig) {}

  private sign(fields: Record<string, string | number>): string {
    const data = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('&');
    return hmacSha256Hex(this.cfg.checksumKey, data);
  }

  async createPayment(order: OrderRow, transferCode: string): Promise<PaymentDraft> {
    const body: Record<string, string | number> = {
      orderCode: order.code,
      amount: order.total,
      description: transferCode,
      cancelUrl: this.cfg.cancelUrl,
      returnUrl: this.cfg.returnUrl,
      expiredAt: Math.floor(order.paymentExpiresAt.getTime() / 1000),
    };
    const signature = this.sign({
      amount: body.amount,
      cancelUrl: body.cancelUrl,
      description: body.description,
      orderCode: body.orderCode,
      returnUrl: body.returnUrl,
    });
    const res = await fetch(`${this.cfg.baseUrl ?? 'https://api-merchant.payos.vn'}/v2/payment-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': this.cfg.clientId,
        'x-api-key': this.cfg.apiKey,
      },
      body: JSON.stringify({ ...body, signature }),
    });
    const json = (await res.json()) as {
      code?: string;
      desc?: string;
      data?: { qrCode?: string; checkoutUrl?: string; paymentLinkId?: string };
    };
    if (!res.ok || json.code !== '00' || !json.data) {
      throw new PaymentVerificationError(`PayOS tạo link thanh toán thất bại: ${json.desc ?? res.status}`);
    }
    return {
      qrString: json.data.qrCode ?? null,
      qrPng: null, // rendered by the caller from qrString
      checkoutUrl: json.data.checkoutUrl ?? null,
      providerRef: json.data.paymentLinkId ?? null,
      instructions: `Quét mã QR hoặc mở link thanh toán. Nội dung chuyển khoản sẽ tự điền: ${transferCode}`,
    };
  }

  parseWebhook(rawBody: Buffer, _headers: Record<string, string | undefined>): WebhookParseResult {
    let parsed: {
      code?: string;
      desc?: string;
      success?: boolean;
      signature?: string;
      data?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, signatureStatus: 'none', reason: 'invalid_json', raw: {}, providerEventId: 'unparseable' };
    }
    const data = parsed.data ?? {};
    const signature = parsed.signature ?? '';
    const expected = this.signWebhookData(data);
    const signatureValid = signature.length > 0 && timingSafeEqualHex(expected, signature);
    const eventId = String(data.reference ?? `${String(data.paymentLinkId ?? 'nolink')}:${String(data.orderCode ?? '0')}`);
    if (!signatureValid) {
      return { ok: false, signatureStatus: 'invalid', reason: 'bad_signature', raw: parsed as Record<string, unknown>, providerEventId: eventId };
    }
    const amount = Number(data.amount ?? 0);
    const orderCode = data.orderCode === undefined || data.orderCode === null ? null : Number(data.orderCode);
    const payment: NormalizedPayment = {
      providerEventId: eventId,
      providerRef: String(data.reference ?? eventId),
      orderCode,
      amount,
      status: parsed.success === true && String(data.code ?? parsed.code) === '00' ? 'success' : 'failed',
      counterAccount: data.counterAccountNumber ? String(data.counterAccountNumber) : null,
      counterAccountName: data.counterAccountName ? String(data.counterAccountName) : null,
      paidAt: data.transactionDateTime ? new Date(String(data.transactionDateTime).replace(' ', 'T') + '+07:00') : new Date(),
      raw: parsed as Record<string, unknown>,
    };
    return { ok: true, signatureStatus: 'valid', payment };
  }

  /** Exported for tests: reproduce the documented webhook signature algorithm. */
  signWebhookData(data: Record<string, unknown>): string {
    const query = Object.keys(data)
      .sort()
      .filter((k) => data[k] !== undefined)
      .map((k) => {
        let value = data[k];
        if (value === null || value === 'null' || value === 'undefined') value = '';
        else if (Array.isArray(value)) {
          value = JSON.stringify(
            value.map((v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort()) : v)),
          );
        }
        return `${k}=${String(value)}`;
      })
      .join('&');
    return hmacSha256Hex(this.cfg.checksumKey, query);
  }
}
