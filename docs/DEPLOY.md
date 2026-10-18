# Triển khai

## Local development

```bash
cp .env.example .env            # điền DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
npm ci
npm run db:migrate              # cần Postgres local (docker run postgres:16 hoặc service sẵn có)
npm run deploy:commands
npm run dev                     # tsx watch; HTTP :8080
npm test
```

Chưa có Postgres? `ALLOW_MEMORY_DB=true` chạy demo nội bộ (mất dữ liệu khi restart,
**không** dùng production, log cảnh báo khi bật).

## Staging

- `PAYMENT_PROVIDER=mock` + `MOCK_WEBHOOK_SECRET` để test luồng mua→pay→deliver không đụng tiền thật.
- Deploy commands vào `DISCORD_GUILD_ID` riêng.
- Webhook mock chỉ accept chữ ký HMAC đúng secret.

## Production (Docker)

```bash
cp .env.example .env   # NODE_ENV=production, đầy đủ secrets, PAYMENT_PROVIDER=payos|manual
docker compose up --build -d
docker compose logs -f bot
```

Compose gồm: `db` (postgres:16 + volume), `migrate` (chạy 1 lần rồi thoát), `bot`
(HTTP :8080 + gateway). Production bắt buộc có: `DATABASE_URL`, `INVENTORY_ENC_KEY`,
`SESSION_SECRET`; `PAYMENT_PROVIDER=mock` bị từ chối.

### Reverse proxy + HTTPS (bắt buộc để webhook & OAuth hoạt động an toàn)

Caddy ví dụ:

```caddy
shop.example.com {
    reverse_proxy bot:8080
}
```

nginx ví dụ:

```nginx
server {
  listen 443 ssl http2;
  server_name shop.example.com;
  ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Sau đó đặt `APP_BASE_URL=https://shop.example.com` và đăng ký webhook PayOS
`https://shop.example.com/webhooks/payments/payos`.

## Scale-out (>1 replica)

Kiến trúc hiện tại giả định **một instance bot** (Discord gateway không nên chạy trùng
token nhiều process; scheduler in-process sẽ chạy trùng lặp). Khi cần ngang cấp:

1. Tách worker HTTP (webhook + dashboard) nhiều replica — an toàn vì idempotency nằm ở DB.
2. Giữ đúng 1 replica gateway; hoặc shard bằng discord.js ShardingManager.
3. Chuyển scheduler sang cron ngoài/BullMQ + Redis để tránh sweep trùng (hiện sweep trùng
   vẫn an toàn nhờ transition có điều kiện, chỉ tốn công vô ích).

## Health & giám sát

- `GET /healthz` → `{ok, uptimeSeconds, db, provider}` — dùng cho container healthcheck/LB.
- Log structured pino (JSON ở production); redact mọi secret/signature/ciphertext.
- Audit log bảng `audit_logs` + trang Audit trong dashboard.

## Cập nhật phiên bản

```bash
git pull
npm run db:migrate     # migration mới (drizzle/migrations)
npm run deploy:commands
docker compose up --build -d
```

Migration sinh bằng `npm run db:generate` sau khi sửa `src/db/schema.ts`; commit file SQL.
