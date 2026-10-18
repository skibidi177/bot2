# Backup & restore

## Dữ liệu cần bảo vệ

1. PostgreSQL (toàn bộ business data: đơn, kho mã hoá, feedback, audit…).
2. Secrets trong `.env`: `DATABASE_URL`, `INVENTORY_ENC_KEY`, `SESSION_SECRET`,
   `PAYOS_*`, `MOCK_WEBHOOK_SECRET`, Discord tokens.
   Mất `INVENTORY_ENC_KEY` = **không giải mã được kho hàng** dù còn backup DB.

## Backup Postgres

```bash
# one-shot
docker compose exec db pg_dump -U bot -Fc bot2 > bot2-$(date +%F).dump

# định kỳ (cron host)
0 3 * * * docker compose -f /opt/bot2/docker-compose.yml exec -T db pg_dump -U bot -Fc bot2 > /backups/bot2-$(date +\%F).dump
```

Giữ tối thiểu 7 bản ngày + 4 bản tuần; lưu khác máy/other region; mã hoá bucket backup.

## Restore

```bash
# DB trống hoàn toàn
docker compose exec -T db pg_restore -U bot -d bot2 --clean --if-exists < bot2-2026-10-18.dump
# sau restore chạy migrate để chắc chắn schema khớp
npm run db:migrate
```

Kiểm tra restore định kỳ (restore vào DB tạm rồi đếm bảng/đơn gần nhất) — backup chưa test = chưa có backup.

## Backup secrets

- Lưu `.env` vào secret manager (Vault/1Password/SOPS), không nằm trong repo backup lẫn DB dump.
- Xoay `SESSION_SECRET` → đăng xuất toàn bộ dashboard (an toàn).
- Xoay `INVENTORY_ENC_KEY`: cần re-encrypt kho (decrypt key cũ → encrypt key mới) — lên kế hoạch
  bảo trì; không xoá key cũ trước khi re-encrypt xong.

## Chính sách lưu giữ

- `audit_logs`, `payment_events`, `order_status_history`: giữ vĩnh viễn (đối soát).
- Đơn huỷ/hết hạn: giữ nguyên (không xoá cứng) để đối soát kho.
- Xoá dữ liệu cá nhân theo yêu cầu: anonymize `users.username/global_name` bằng update SQL,
  giữ id dạng hash để không phá FK đơn hàng.
