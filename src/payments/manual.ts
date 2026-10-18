import type { OrderRow } from '../db/types.js';
import { buildVietQrString, vietQrPng } from './vietqr.js';
import type { PaymentDraft, PaymentProvider, WebhookParseResult } from './types.js';

export interface BankConfig {
  bin: string;
  accountNumber: string;
  accountName: string;
  displayName?: string;
}

/**
 * Self-hosted VietQR mode: the bot renders its own QR to the shop bank account.
 * There is NO automated bank verification in this mode — payments must be
 * confirmed by staff holding the FINANCE permission (every confirmation is
 * audit-logged). This is deliberate: we never pretend a transfer happened.
 */
export class ManualVietQrProvider implements PaymentProvider {
  readonly name = 'manual';
  readonly automated = false;
  constructor(private readonly bank: BankConfig) {}

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
      instructions: [
        `Chuyển khoản đúng số tiền tới ${this.bank.displayName ?? this.bank.accountName} — ${this.bank.accountNumber}.`,
        `Nội dung chuyển khoản: ${transferCode}`,
        'Đơn được xác nhận tự động khi cửa hàng xác minh giao dịch, hoặc bởi nhân viên Finance.',
      ].join('\n'),
    };
  }

  parseWebhook(_rawBody: Buffer, _headers: Record<string, string | undefined>): WebhookParseResult {
    return {
      ok: false,
      signatureStatus: 'none',
      reason: 'manual provider does not accept webhooks',
      raw: {},
      providerEventId: 'manual-no-webhook',
    };
  }
}
