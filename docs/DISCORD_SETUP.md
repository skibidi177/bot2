# Discord Application setup

## 1. Tạo application & bot

1. https://discord.com/developers/applications → *New Application*.
2. Tab **Bot** → *Reset Token* → lưu vào `DISCORD_TOKEN`.
3. Tab **General Information** → copy `Application ID` → `DISCORD_CLIENT_ID`.
4. Tab **Installation / OAuth2 URL generator**: scopes `bot`, `applications.commands`.
   Permissions tối thiểu khuyến nghị:
   `View Channels, Send Messages, Embed Links, Attach Files, Use Slash Commands,
   Create Public Threads, Manage Threads, Moderate Members, Kick Members, Ban Members, Manage Roles`.
5. Mời bot bằng URL sinh ra ở bước 4 (hoặc tab *Installation* → install link).

## 2. Privileged intents (bật tay — code không tự bật được)

Tab **Bot → Privileged Gateway Intents**:

- `SERVER MEMBERS INTENT` — cần cho welcome/autorole/verification.
- `MESSAGE CONTENT INTENT` — cần cho anti-spam theo nội dung/mention.

Thiếu intent: bot vẫn chạy, các module liên quan tự vô hiệu (log cảnh báo).

## 3. Đăng ký lệnh

```bash
DISCORD_GUILD_ID=<id> npm run deploy:commands   # dev: cập nhật tức thì trong 1 server
npm run deploy:commands                          # prod: global (propagate tối đa ~1h)
```

Lệnh hỗ trợ cả guild lẫn DM/user-install (`/shop`, `/don-hang`, `/lich-su-mua`, `/danh-gia`,
`/ticket`, `/faq`, `/help`, `/loi-moi`) nhờ `setContexts(Guild, BotDM)`.

## 4. Bot Profile & các mục chỉ cấu hình thủ công

Discord **không** cung cấp API tự động đổi các mục sau; làm tay trong Developer Portal:

| Mục | Nơi cấu hình |
|---|---|
| Tên bot, avatar, banner, mô tả ngắn/dài | Portal → General / Branding |
| Default rich presence / activity | Code hỗ trợ: `client.user.setActivity('/shop · MMO Shop')` khi ready |
| Profile Entry Point (nút trên profile app) | Portal → yêu cầu app đủ điều kiện/verification |
| App Directory listing, tag, privacy policy URL | Portal → App Directory / Verification |
| User-install (DM) | Portal → Installation → *User Install* scope |

Những gì code tự làm: activity khi ready, toàn bộ commands/components/embeds, phân quyền nội bộ.

## 5. OAuth2 cho admin dashboard

Portal → **OAuth2 → Redirects** thêm:

```
{APP_BASE_URL}/api/admin/auth/callback
```

Đặt `DISCORD_OAUTH_CLIENT_ID` / `DISCORD_OAUTH_CLIENT_SECRET` (Portal → OAuth2 → client secret).
Đăng nhập dashboard = luồng authorization_code scope `identify`; session cookie HMAC 12h.
Quyền xem trang do RBAC server quyết định theo bảng `staff_permissions` + `BOOTSTRAP_OWNER_IDS`.

## 6. Cấu hình trong server (sau khi bot vào)

```text
/admin config-set key:channels.welcome value:<id>      + modules.welcome true
/admin config-set key:channels.logs value:<id>
/admin config-set key:channels.staffAlerts value:<id>
/admin config-set key:channels.feedback value:<id>
/admin config-set key:channels.ticketCategory value:<id>
/admin config-set key:channels.announcements value:<id>
/admin config-set key:roles.verified value:<id>        + modules.verification true
/admin config-set key:roles.autorole value:<id>        + modules.autorole true
/admin config-set key:modules.antispam value:true
/admin verify-setup                                     # đăng message nút xác minh
```

Bot cần quyền quản lý role đứng **trên** role sẽ cấp (verified/autorole) và quyền
Moderate Members/Kick/Ban tương ứng phần moderation.
