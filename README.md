# bot2 — Discord MMO Shop Bot

Bot bán sản phẩm số MMO chuyên nghiệp cho Discord: catalog + kho hàng, đơn hàng,
thanh toán chuyển khoản qua **VietQR**, đối soát giao dịch qua **payment provider adapter**
(PayOS hoặc xác minh thủ công có audit), giao hàng tự động qua DM, feedback/uy tín,
loyalty/referral, ticket, moderation, RBAC + admin dashboard web.

> Nguyên tắc cốt lõi: **không bao giờ giả lập thanh toán thành công ở production**.
> QR chỉ là phương tiện nhận tiền; đơn chỉ chuyển trạng thái khi giao dịch được
> đối soát hợp lệ (webhook có chữ ký hoặc nhân viên Finance xác nhận, mọi thao tác ghi audit log).

## Kiến trúc tổng quan

```
src/
├─ config/env.ts          Zod-validated environment (fail fast khi thiếu biến quan trọng)
├─ core/                  logger (pino, redact secrets), errors, crypto (AES-256-GCM, HMAC), csv, ids
├─ db/
│  ├─ schema.ts           Drizzle schema (PostgreSQL): 19 bảng + enums + indexes + sequence
│  ├─ repo.ts             Facade `Db` — hợp đồng storage duy nhất của business logic
│  ├─ drizzle.ts          Implementation Postgres (transactions thật, SELECT … FOR UPDATE SKIP LOCKED)
│  ├─ memory.ts           Implementation in-memory (TEST / demo local, KHÔNG dùng production)
│  └─ migrate.ts          Chạy migration SQL (drizzle/migrations/*.sql)
├─ services/              Business logic thuần, không phụ thuộc discord.js
│  ├─ orders.ts           Tạo đơn (reserve kho trong transaction), huỷ, hết hạn, hoàn tiền…
│  ├─ payments-service.ts Ingest webhook: idempotency, đối soát số tiền, state machine đơn
│  ├─ delivery.ts         Giao hàng tự động qua DM / chuyển thủ công + cảnh báo staff
│  ├─ feedback.ts         Đánh giá 1 lần/đơn, ẩn/rep, thống kê uy tín
│  ├─ catalog.ts          Nhập kho (text/CSV), báo tồn kho thấp
│  ├─ loyalty.ts          Điểm + referral thưởng (ledger, không sửa lịch sử)
│  ├─ rbac.ts             Ma trận quyền OWNER/ADMINISTRATOR/FINANCE/PM/SUPPORT/MODERATOR
│  └─ tickets.ts, pricing.ts, guild-settings.ts, notifier.ts (interface DM/channel)
├─ payments/
│  ├─ vietqr.ts           Builder EMV-CoIP VietQR (đã đối chiếu QR thật + mẫu PayOS), CRC16-CCITT
│  ├─ payos.ts            Adapter PayOS (API + webhook signature theo docs chính thức)
│  ├─ manual.ts           Mode tự phát hành QR ngân hàng shop, xác minh thủ công có audit
│  ├─ mock.ts             Provider TEST/STAGING (webhook bảo vệ bằng HMAC, cấm ở production)
│  └─ types.ts            Hợp đồng PaymentProvider adapter
├─ discord/               Commands, buttons/selects/modals, events (welcome/autorole/anti-spam)
├─ http/                  Fastify: /healthz, /webhooks/payments/:provider, /api/admin/*, /admin (UI)
├─ jobs/scheduler.ts      Quét đơn hết hạn + cảnh báo tồn kho thấp
└─ index.ts               Bootstrap + graceful shutdown
```

## Yêu cầu

- Node.js ≥ 22, PostgreSQL ≥ 14 (production), Discord Application (bot token).
- Tuỳ chọn: PayOS account (để đối soát tự động), Redis **không bắt buộc** ở kiến trúc hiện tại
  (scheduler in-process; xem `docs/DEPLOY.md` giới hạn khi chạy nhiều replica).

## Cài đặt từ đầu

```bash
# 1. Clone & cài đặt
git clone <repo-url> && cd bot2
npm ci

# 2. Cấu hình môi trường
cp .env.example .env
# Điền: DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL,
#       INVENTORY_ENC_KEY (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
#       SESSION_SECRET (≥32 ký tự), BOOTSTRAP_OWNER_IDS=<discord-user-id-của-bạn>
#       PAYMENT_PROVIDER=manual + BANK_BIN/BANK_ACCOUNT_NUMBER/BANK_ACCOUNT_NAME
#       hoặc PAYMENT_PROVIDER=payos + PAYOS_CLIENT_ID/PAYOS_API_KEY/PAYOS_CHECKSUM_KEY

# 3. Database
npm run db:migrate          # áp dụng drizzle/migrations/*.sql

# 4. Đăng ký slash commands
npm run deploy:commands     # global; đặt DISCORD_GUILD_ID để deploy nội bộ server dev

# 5. Chạy
npm run dev                 # development (tsx watch)
npm run build && npm start  # production
```

Docker (khuyến nghị production):

```bash
docker compose up --build -d   # db + migrate + bot (xem docs/DEPLOY.md cho reverse proxy/HTTPS)
```

## Cấu hình Discord Developer Portal (thủ công — code không tự làm được)

1. Tạo application tại https://discord.com/developers/applications → Bot → reset token → `DISCORD_TOKEN`.
2. **Privileged intents**: bật `SERVER MEMBERS INTENT` (welcome/autorole/verification) và
   `MESSAGE CONTENT INTENT` (anti-spam). Thiếu intents các module tương ứng sẽ tắt.
3. OAuth2 URL generator: scopes `bot` + `applications.commands`; permissions tối thiểu:
   `View Channels, Send Messages, Embed Links, Attach Files, Use Slash Commands,
   Create Public Threads, Manage Threads, Moderate Members, Kick Members, Ban Members,
   Manage Roles` (chỉ cấp gì bạn dùng).
4. OAuth2 → Redirects: thêm `{APP_BASE_URL}/api/admin/auth/callback` (đăng nhập dashboard).
5. Bot Profile (tên, avatar, mô tả, avatar decoration, Profile Entry Point/Activity):
   cấu hình **bằng tay trong Developer Portal** — Discord không cho API tự đổi những mục này.
   Xem `docs/DISCORD_SETUP.md` checklist chi tiết.

## Vận hành cửa hàng (quick start)

```text
/admin category-add slug:account name:"Account MMO"
/admin product-create sku:ACC-001 name:"Account MMO cao cấp" price:50000 category:account delivery:AUTO
/admin inventory-add product_id:1 file:keys.csv        # csv cột `secret` hoặc `sku,secret`
/admin config-set key:channels.staffAlerts value:<channel-id>
/admin config-set key:channels.feedback value:<channel-id>
/admin staff-grant user:@finance role:FINANCE
```

Người mua: `/shop` → chọn danh mục → sản phẩm → số lượng/mã giảm giá → nhận QR + nội dung
chuyển khoản (`M<mã đơn>`) → hệ thống đối soát → DM sản phẩm → `/danh-gia`.

## Thanh toán

| Mode | Đối soát | Khi nào dùng |
|---|---|---|
| `payos` | Webhook signature HMAC-SHA256 (docs chính thức PayOS) tự động xác nhận | Có tài khoản PayOS đã xác thực |
| `manual` | Nhân viên `FINANCE` xác nhận (`/admin order-confirm` hoặc dashboard), audit log bắt buộc | Chưa có provider; vẫn phát hành VietQR chuẩn |
| `mock` | Webhook giả lập bảo vệ bằng HMAC `MOCK_WEBHOOK_SECRET` | **Test/staging duy nhất**, production từ chối khởi động |

Chi tiết tích hợp thật, replay/duplicate, sai/thừa/thiếu tiền, đơn hết hạn, thanh toán đến muộn:
`docs/PAYMENTS.md`. Định dạng QR và cấu hình ngân hàng: `docs/QR_BANK.md`.

## Bảo mật

- Secrets chỉ qua environment variables; log redact token/key/signature/ciphertext.
- Kho hàng mã hoá AES-256-GCM (`INVENTORY_ENC_KEY`); API/dashboard không bao giờ trả plaintext/ciphertext.
- Webhook: chữ ký + timestamp/idempotency (`payment_events` unique provider+event id),
  giao dịch unique (`payment_transactions`), chuyển trạng thái đơn có điều kiện trong transaction.
- RBAC kiểm tra **server-side** cho mọi endpoint; session cookie HMAC, SameSite=Lax, chặn cross-origin POST.
- Rate limit toàn cục HTTP + cooldown nghiệp vụ (feedback, anti-spam guild).
- Không eval, không thực thi input người dùng; không log nội dung sản phẩm ra channel công khai.

## Kiểm thử

```bash
npm test          # 45 tests: unit + integration + e2e (memory DB + mock provider)
npm run typecheck # tsc strict
npm run lint      # eslint
npm run build
```

Test **không dùng giao dịch ngân hàng thật**; vector chữ ký PayOS lấy nguyên văn từ docs chính thức;
vector VietQR đối chiếu QR thật đã giải mã (`docs/assets/reference-vietqr.jpg`).

## Tài liệu

- `docs/DISCORD_SETUP.md` — tạo app, intents, permissions, bot profile, entry points.
- `docs/PAYMENTS.md` — provider adapter, PayOS, manual, mock, xử lý ngoại lệ thanh toán.
- `docs/QR_BANK.md` — chuẩn VietQR, cấu hình ngân hàng, đối chiếu mẫu.
- `docs/DEPLOY.md` — local/staging/production, Docker, reverse proxy, scale-out.
- `docs/BACKUP.md` — backup/restore Postgres + secrets.
- `docs/TROUBLESHOOTING.md` — lỗi thường gặp và cách xử lý.
- `docs/STATUS.md` — ma trận tính năng hoàn thành / chưa hoàn thành / giới hạn ngoài + giả định.
