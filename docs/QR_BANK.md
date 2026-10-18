# VietQR / cấu hình ngân hàng

## Chuẩn payload

Builder `src/payments/vietqr.ts` sinh EMV-CoIP (NAPAS/VietQR) TLV:

```
00 02 01                payload format indicator
01 02 11|12             11 tĩnh / 12 động (có số tiền)
38 xx                   thông tin tài khoản VietQR
   00 10 A000000727       RID NAPAS
   01 xx                  TLV con: 00 = BIN ngân hàng, 01 = số tài khoản
   02 08 QRIBFTTA         mã dịch vụ chuyển tiền liên ngân hàng
53 03 704               tiền tệ VND
54 xx <amount>          số tiền (chỉ ở QR động)
58 02 VN                quốc gia
62 xx                   dữ liệu thêm
   08 xx <message>        nội dung chuyển khoản (mã đơn)
63 04 <crc>             CRC16-CCITT (init 0xFFFF, poly 0x1021) tính cả chuỗi "6304"
```

Đối chiếu thực tế:

- QR tham chiếu đính kèm brief (giải mã bằng jsQR, xem `docs/assets/reference-vietqr.jpg`)
  khớp byte-for-byte với output builder khi không truyền amount/message
  (`test/unit/vietqr.test.ts`).
- Mẫu `qrCode` trong docs PayOS được parse để kiểm tra tag 54/62 (chuỗi mẫu trong docs
  có độ dài tag 38 không tự nhất quán nên không dùng làm vector CRC).

## Cấu hình

```env
PAYMENT_PROVIDER=manual            # hoặc payos
BANK_BIN=970418                    # BIN 6 số (970418 = BIDV)
BANK_ACCOUNT_NUMBER=8875505786
BANK_ACCOUNT_NAME=HOANG HUE QUYNH  # in hoa, không dấu, đúng đăng ký ngân hàng
BANK_DISPLAY_NAME=BIDV-CN NAM HA NOI PGD XA LA   # tuỳ chọn, hiển thị hướng dẫn
```

Kiểm tra nhanh:

```bash
node -e "
import('./dist/payments/vietqr.js').then(async (m) => {
  const s = m.buildVietQrString({ bin: process.env.BANK_BIN, accountNumber: process.env.BANK_ACCOUNT_NUMBER, accountName: process.env.BANK_ACCOUNT_NAME, amount: 50000, message: 'M100042' });
  console.log(s, m.verifyVietQrCrc(s));
  require('fs').writeFileSync('qr.png', await m.vietQrPng(s));
})"
```

## Nội dung chuyển khoản

- Định dạng `M<mã đơn>` (ví dụ `M100042`): ngắn (≤9 ký tự với đa số ngân hàng khi dùng
  PayOS), không dấu, duy nhất theo sequence đơn hàng → đối soát thủ công dễ.
- Mã đơn đến từ PostgreSQL sequence `order_code_seq` (bắt đầu 100001) → không đoán trước được
  theo thời gian và không trùng.

## Lưu ý vận hành

- QR đính kèm embed dưới dạng file PNG attachment (không dùng dịch vụ render bên thứ ba).
- Màu QR xanh đậm `#04594c` theo nhận diện VietQR, nền trắng, ECC level M — quét tốt bằng
  mọi app ngân hàng phổ biến; nếu môi trường in ấn kém contrast có thể đổi về `#000000` trong `vietQrPng`.
- Không nhúng thông tin nhạy cảm nào khác vào QR (chỉ BIN + STK + tên + tiền + nội dung).
