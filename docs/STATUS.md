# Trạng thái triển khai (cập nhật 2026-10-18)

## Giả định đầu vào

- File `hdt.zip` được nhắc trong brief **không có trong workspace** khi bắt đầu
  (chỉ có ảnh `maqrnganhang2.png`). Ảnh QR được dùng làm tài liệu tham chiếu:
  đã giải mã payload VietQR thật bên trong (BIDV BIN 970418, tài khoản 8875505786,
  chủ tài khoản HOANG HUE QUYNH) để kiểm chứng builder EMV (`test/unit/vietqr.test.ts`).
  Ảnh gốc lưu tại `docs/assets/reference-vietqr.jpg` (đuôi .jpg vì nội dung là JPEG).
- Thông tin ngân hàng thật không được hardcode vào source; chỉ đọc từ environment.

## Đã hoàn thành (có implementation + test)

| Khu vực | Hạng mục |
|---|---|
| Nền tảng | TypeScript strict, eslint, vitest, pino redact, zod env fail-fast, graceful shutdown, healthcheck |
| Database | 19 bảng Drizzle + migration SQL sinh sẵn, indexes, unique constraints, sequence mã đơn, soft delete sản phẩm |
| Storage | Facade `Db` 2 implementation (Postgres transaction thật / in-memory cho test), repo reserve kho dùng `FOR UPDATE SKIP LOCKED` |
| Shop | Danh mục, sản phẩm (SKU, giá, ảnh, ẩn/ xoá mềm), biến thể, tìm kiếm/lọc, coupon (percent/fixed, max uses, per-user, min order, hạn) |
| Đơn hàng | 9 trạng thái + lịch sử trạng thái, tạo đơn reserve kho atomic, huỷ, hết hạn tự động giải phóng kho, tra cứu đơn/lich sử |
| Thanh toán | VietQR EMV builder + CRC16 (đối chiếu QR thật), PayOS adapter (API + webhook signature theo docs), manual mode có audit, mock provider cho test, idempotency event/transaction, đối soát số tiền, MANUAL_REVIEW, thanh toán đến muộn |
| Giao hàng | DM secrets giải mã đúng 1 lần, DM đóng → PROCESSING + ticket/alert + redeliver, sản phẩm thủ công → PROCESSING + alert staff |
| Feedback | 1 lần/đơn, chỉ người mua đơn COMPLETED, rating 1–5, post channel cấu hình, ẩn/rep có audit, thống kê uy tín realtime, cooldown chống spam |
| Discord UX | Slash commands (guild + DM/user-install contexts), selects/buttons/modals có hạn phiên + thông báo hết hạn, embed nhất quán, không button trang trí |
| Community | Welcome/autorole/verification button, anti-spam flood + mention spam (timeout có audit), ticket thread + đóng, FAQ/help, announce, warn/kick/ban/timeout/unban theo permission thật |
| Loyalty | Điểm theo ledger (không sửa lịch sử), tier, referral chống tự giới thiệu/thưởng 1 lần |
| Admin | Dashboard web `/admin` (SPA vanilla gọi API), REST `/api/admin/*` RBAC server-side, Discord OAuth2 session HMAC, chặn cross-origin, rate limit, audit log đầy đủ |
| RBAC | 6 vai trò + ma trận quyền, hoàn tiền tách riêng Finance/Owner, grant/revoke theo hạng, bootstrap owner qua env |
| Vận hành | Scheduler hết hạn + tồn kho thấp, Dockerfile multi-stage, docker-compose (db+migrate+bot), README + 6 docs |
| Kiểm thử | 45 tests xanh: unit (VietQR, PayOS signature vector chính thức, pricing, rbac, csv, state machine), integration (flow, race kho, feedback, admin API), e2e mua→pay→deliver→feedback |

## Chưa hoàn thành / cần làm ở giai đoạn sau

- Dashboard web nâng cao (biểu đồ doanh thu, pagination UI đầy đủ, quản lý variant qua UI, import CSV qua UI file picker) — API đã có sẵn endpoint tương ứng.
- Product variants trong luồng mua Discord (schema + repo sẵn; UI Discord hiện bán bản gốc).
- BullMQ/Redis cho hàng đợi khi chạy **nhiều replica** (hiện scheduler in-process, docs nêu rõ).
- Polling provider cho ngân hàng không có webhook (thiết kế adapter đã mở, chưa implement provider cụ thể).
- i18n đa ngôn ngữ (hiện tiếng Việt là chính).
- App Directory listing / verification badge — thủ công qua Discord.

## Giới hạn phụ thuộc bên ngoài (cần cấu hình tay)

- Discord Bot Profile (tên/avatar/mô tả/entry point): chỉ đổi được trong Developer Portal.
- Intent SERVER MEMBERS / MESSAGE CONTENT: bật tay trong Portal.
- PayOS credentials + webhook URL đăng ký tại my.payos.vn (hướng dẫn `docs/PAYMENTS.md`).
- HTTPS/reverse proxy cho webhook + dashboard: hạ tầng người dùng (Caddy/nginx mẫu trong `docs/DEPLOY.md`).
- Xác minh ngân hàng ở `manual` mode là con người (Finance) — có chủ đích, không giả lập.
