# Lỗi thường gặp

## Khởi động

| Triệu chứng | Nguyên nhân / cách sửa |
|---|---|
| `Invalid environment configuration` | Thiếu/sai định dạng biến env (xem message liệt kê từng biến). |
| `Production environment missing required variables` | NODE_ENV=production bắt buộc DISCORD_TOKEN, DATABASE_URL, INVENTORY_ENC_KEY, SESSION_SECRET (+ PayOS keys nếu provider payos). |
| `PAYMENT_PROVIDER=mock is forbidden in production` | Đúng luật — đổi provider hoặc NODE_ENV. |
| `DATABASE_URL is not set…` | Chưa đặt DB; hoặc cố tình demo: `ALLOW_MEMORY_DB=true`. |
| `Used DISCORD_TOKEN is invalid` (gateway) | Token sai/hết hạn → reset trong Portal. |
| Crash loop sau migrate | Xem log `migrate` service: thiếu quyền DB hoặc migration cũ hơn schema → chạy lại `npm run db:migrate`. |

## Discord

| Triệu chứng | Cách sửa |
|---|---|
| Lệnh không hiện | Chưa `npm run deploy:commands`; global cần chờ propagate; dev đặt `DISCORD_GUILD_ID`. |
| Welcome/autorole không chạy | Thiếu SERVER MEMBERS INTENT hoặc chưa cấu hình `channels.welcome`/`roles.autorole`. |
| Anti-spam không timeout | Bot thiếu quyền Moderate Members hoặc role bot thấp hơn đối tượng. |
| Nút/select báo "hết hạn" | Component sống 15 phút (chủ đích); gọi lại `/shop`. |
| Không DM được sản phẩm | Người mua khoá DM → đơn PROCESSING + alert staff; dùng `/admin order-redeliver` sau khi họ mở DM. |
| Embed không có ảnh sản phẩm | `image_url` phải là URL công khai https. |

## Thanh toán

| Triệu chứng | Cách xử lý |
|---|---|
| PayOS create link lỗi `signature` | Kiểm tra `PAYOS_CHECKSUM_KEY` đúng kênh thanh toán; description ≤ 9 ký tự với tài khoản không liên kết (bot dùng `M<mã đơn>`). |
| Webhook 404 | Sai đường dẫn: phải là `/webhooks/payments/payos` (hoặc `/mock`). |
| Đơn stuck PENDING_PAYMENT | Provider manual: Finance xác nhận tay; provider payos: kiểm tra webhook đăng ký + log `payment.*` audit. |
| `amount_mismatch` / MANUAL_REVIEW | Đối soát sao kê; hoàn tiền (`/admin order-refund`) hoặc xác nhận phần đúng theo quy trình Finance. |
| Tiền đến nhưng đơn EXPIRED | Đơn tự chuyển MANUAL_REVIEW + alert; Finance quyết định hoàn tiền hoặc phục hồi. |
| QR không quét được | In/hiển thị sai tỷ lệ; thử tăng `width` trong `vietQrPng` hoặc đổi màu dark về `#000000`. |

## Dashboard

| Triệu chứng | Cách sửa |
|---|---|
| `/admin` báo chưa đăng nhập | Chưa OAuth; kiểm tra Redirect URI khớp `{APP_BASE_URL}/api/admin/auth/callback`. |
| 403 sau đăng nhập | User chưa có hàng trong `staff_permissions` của guild đang chọn (hoặc BOOTSTRAP_OWNER_IDS). |
| 403 origin không hợp lệ | Truy cập qua host khác `APP_BASE_URL` (mở đúng domain cấu hình). |

## Hiệu năng / vận hành

- Sweep đơn hết hạn chạy mỗi `ORDER_SWEEP_INTERVAL_SECONDS`; đơn tồn PENDING quá lâu → kiểm tra scheduler log.
- Rate limit HTTP 300 req/phút/IP; webhook provider nằm trong giới hạn này — nếu provider bắn burst lớn, nâng `max` trong `src/http/app.ts`.
- Memory DB demo mất dữ liệu khi restart — đúng thiết kế.

## Chẩn đoán nhanh

```bash
curl -s $APP_BASE_URL/healthz                      # bot + db + provider
# audit gần nhất của một đơn
psql "$DATABASE_URL" -c "select created_at,action,actor_id,detail from audit_logs where target_id='100042' order by id desc"
# trạng thái kho một sản phẩm
psql "$DATABASE_URL" -c "select status,count(*) from inventory_items where product_id=1 group by 1"
```
