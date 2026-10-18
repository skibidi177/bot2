import type { OrderRow } from '../db/types.js';

export interface PaymentDraft {
  /** EMV VietQR string, when the provider renders a QR we own. */
  qrString: string | null;
  qrPng: Buffer | null;
  checkoutUrl: string | null;
  providerRef: string | null;
  instructions: string;
}

export interface NormalizedPayment {
  providerEventId: string;
  providerRef: string;
  orderCode: number | null;
  amount: number;
  status: 'success' | 'failed' | 'pending';
  counterAccount: string | null;
  counterAccountName: string | null;
  paidAt: Date | null;
  raw: Record<string, unknown>;
}

export type WebhookParseResult =
  | { ok: true; signatureStatus: 'valid' | 'none'; payment: NormalizedPayment }
  | { ok: false; signatureStatus: 'valid' | 'invalid' | 'none'; reason: string; raw: Record<string, unknown>; providerEventId: string };

export interface PaymentProvider {
  readonly name: string;
  /** True when payments are verified automatically by this provider (webhook). */
  readonly automated: boolean;
  createPayment(order: OrderRow, transferCode: string): Promise<PaymentDraft>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookParseResult;
}
