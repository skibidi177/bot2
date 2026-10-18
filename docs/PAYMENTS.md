# Thanh toán & đối soát giao dịch

## Kiến trúc adapter

`PaymentProvider` (`src/payments/types.ts`) là hợp đồng duy nhất:

```ts
createPayment(order, transferCode) -> { qrString, qrPng, checkoutUrl, providerRef, instructions }
parseWebhook(rawBody, headers)     -> { ok, signatureStatus, payment | reason }
```

Ba implementation:

| Provider | `PAYMENT_PROVIDER` | Đối soát tự động | Ghi chú |
|---|---|---|---|
| PayOS | `payos` | ✅ webhook HMAC-SHA256 | Cần `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` |
| Thủ công | `manual` | ❌ (Finance xác nhận) | Phát hành VietQR chuẩn tới tài khoản shop; không giả mạo xác minh |
| Mock | `mock` | ✅ webhook HMAC nội bộ | Chỉ test/staging; production từ chối khởi động |

Thêm provider mới: implement interface + đăng ký trong `buildProviders()` + viết test signature.

## PayOS (tích hợp theo docs chính thức)

- Tạo link: `POST https://api-merchant.payos.vn/v2/payment-requests`, header `x-client-id`, `x-api-key`.
  Body gồm `orderCode` (mã đơn integer), `amount`, `description` (= nội dung CK `M<mã đơn>`),
  `cancelUrl`, `returnUrl`, `expiredAt`, `signature` = HMAC_SHA256(checksumKey,
  `amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..` sort alphabet).
- Webhook: body `{code, desc, success, data{...}, signature}`; `signature` = HMAC_SHA256(checksumKey,
  data serialize `key=value&...` sort alphabet, null/undefined = chuỗi rỗng).
  Vector kiểm chứng nằm trong `test/unit/payos-signature.test.ts` (copy nguyên văn từ docs PayOS).
- Đăng ký webhook URL: `{APP_BASE_URL}/webhooks/payments/payos` trong my.payos.vn.
  PayOS gửi ping kiểm tra khi đăng ký — handler ghi event và ACK 200 nên quá trình đăng ký thành công.

## Quy trình xử lý webhook (mọi provider)

1. Parse + verify chữ ký. Sai chữ ký → lưu `payment_events(signature_status=invalid)` + audit, ACK 200, **không xử lý**.
2. Lưu event (unique `provider+provider_event_id`) → trùng lặp → ACK, không xử lý lại.
3. Tìm đơn theo `orderCode`; không thấy → audit `payment.unknown_order`.
4. Sai số tiền → tạo transaction `amount_mismatch`, đơn → `MANUAL_REVIEW`, alert staff. Không giao hàng.
5. Transaction success unique `provider+provider_ref` → trùng → bỏ qua (chống double settle).
6. Chuyển `PENDING_PAYMENT → PAID` **có điều kiện** (đơn đã đổi trạng thái bởi webhook song song → audit `payment.race_lost`).
7. Fulfill: kho RESERVED → SOLD + DM secrets; sản phẩm thủ công → `PROCESSING` + alert.
8. Đơn đã `EXPIRED/CANCELLED` mà tiền vẫn đến → `MANUAL_REVIEW` + alert (không tự hoàn tiền).
9. Loyalty + referral thưởng khi đơn `COMPLETED`; audit `payment.confirmed`.

## Manual mode (chưa có provider)

- Bot tự render VietQR (xem `QR_BANK.md`) với số tiền + nội dung `M<mã đơn>`.
- Không có webhook: Finance đối soát sao kê ngân hàng rồi
  `/admin order-confirm code:<mã> amount:<số tiền> ref:<mã GD>` hoặc nút tương ứng trên dashboard.
  Số tiền bắt buộc khớp tổng đơn; mọi xác nhận ghi audit `payment.confirmed` kèm actor.
- Tuyệt đối không cho người mua tự đánh dấu đã trả: button "Kiểm tra thanh toán" chỉ đọc trạng thái.

## Mock mode (test/staging)

```bash
PAYMENT_PROVIDER=mock MOCK_WEBHOOK_SECRET=...
# giả lập giao dịch:
BODY='{"orderCode":100001,"amount":50000,"reference":"TX-1"}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256',process.env.MOCK_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST $APP_BASE_URL/webhooks/payments/mock -H 'content-type: application/json' -H "x-mock-signature: $SIG" -d "$BODY"
```

Test tự động dùng đúng cơ chế này (`test/helpers.ts signMockWebhook`).

## Ngoại lệ đã xử lý

- Webhook trùng / replay → idempotency 2 tầng (event + transaction).
- Hai webhook đồng thời → transition có điều kiện + unique constraints.
- Thiếu/thừa tiền → MANUAL_REVIEW, không giao hàng.
- Đơn hết hạn rồi tiền mới đến → MANUAL_REVIEW + alert.
- DM người mua đóng → PROCESSING + ticket/alert + `/admin order-redeliver`.
