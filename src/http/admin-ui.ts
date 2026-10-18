/**
 * Minimal built-in admin dashboard (single page, vanilla JS, session cookies).
 * It talks only to the RBAC-protected /api/admin/* endpoints; the server always
 * re-checks permissions, the UI never decides access.
 */
export const ADMIN_UI_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MMO Shop — Admin</title>
<style>
  :root { --brand:#04594c; --bg:#f6f8f7; --card:#fff; --line:#e2e8f0; --text:#0f172a; --muted:#64748b; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { background:var(--brand); color:#fff; padding:12px 20px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; }
  header input, header button { padding:6px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.35); background:rgba(255,255,255,.12); color:#fff; }
  header input::placeholder { color:#d7e5e1; }
  nav { display:flex; gap:6px; padding:10px 20px; background:#fff; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav button { border:1px solid var(--line); background:#fff; border-radius:999px; padding:6px 14px; cursor:pointer; }
  nav button.on { background:var(--brand); color:#fff; border-color:var(--brand); }
  main { padding:20px; max-width:1200px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .pill { padding:2px 8px; border-radius:999px; font-size:12px; background:#eef2f1; }
  .btn { border:1px solid var(--line); background:#fff; border-radius:8px; padding:5px 10px; cursor:pointer; margin-right:4px; }
  .btn.primary { background:var(--brand); color:#fff; border-color:var(--brand); }
  .btn.danger { background:#b91c1c; color:#fff; border-color:#b91c1c; }
  input,select,textarea { padding:7px 9px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px; }
  pre { background:#0f172a; color:#e2e8f0; padding:12px; border-radius:10px; overflow:auto; font-size:12px; }
  .muted { color:var(--muted); }
  #err { color:#b91c1c; margin:8px 0; }
</style>
</head>
<body>
<header>
  <h1>🛒 MMO Shop Admin</h1>
  <input id="guild" placeholder="Guild ID" size="22">
  <button class="btn" onclick="login()">Đăng nhập Discord</button>
  <button class="btn" onclick="logout()">Đăng xuất</button>
  <span id="me" class="muted"></span>
</header>
<nav id="nav"></nav>
<main>
  <div id="err"></div>
  <div id="view"></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
let current = 'overview';
const TABS = [
  ['overview','Tổng quan'],['orders','Đơn hàng'],['products','Sản phẩm & kho'],
  ['feedback','Feedback'],['coupons','Coupon'],['tickets','Ticket'],
  ['staff','Nhân sự'],['audit','Audit log'],['config','Cấu hình']
];
function gid() { return $('#guild').value.trim(); }
async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = '/api/admin' + path + (opts.noGuild ? '' : sep + 'guildId=' + encodeURIComponent(gid()));
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
function err(e) { $('#err').textContent = e.message || String(e); }
function login() { location.href = '/api/admin/auth/login'; }
async function logout() { await fetch('/api/admin/auth/logout', { method: 'POST' }); location.reload(); }
async function me() {
  try { const d = await fetch('/api/admin/auth/me').then(r => r.ok ? r.json() : null);
    $('#me').textContent = d ? '👤 ' + d.uid + (d.bootstrapOwner ? ' (bootstrap owner)' : '') : 'chưa đăng nhập';
  } catch { $('#me').textContent = 'chưa đăng nhập'; }
}
function renderNav() {
  $('#nav').innerHTML = TABS.map(([id, label]) =>
    '<button class="' + (id === current ? 'on' : '') + '" onclick="go(\\'' + id + '\\')">' + label + '</button>').join('');
}
function go(tab) { current = tab; renderNav(); view().catch(err); }
function table(cols, rows, cellFn) {
  if (!rows.length) return '<p class="muted">Trống</p>';
  return '<table><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + cellFn(r) + '</tr>').join('') + '</table>';
}
const fmt = (n) => Number(n).toLocaleString('vi-VN') + '₫';
const dstr = (d) => d ? new Date(d).toLocaleString('vi-VN') : '—';
async function view() {
  $('#err').textContent = '';
  const v = $('#view');
  if (!gid()) { v.innerHTML = '<div class="card">Nhập Guild ID phía trên rồi chọn tab.</div>'; return; }
  if (current === 'overview') {
    const d = await api('/overview');
    v.innerHTML = '<div class="card"><h3>30 ngày</h3><p>Doanh thu ghi nhận: <b>' + fmt(d.revenue30.total) +
      '</b> · Đơn thanh toán: ' + d.revenue30.count + '</p><p>Đơn hoàn thành: ' + d.stats.completedOrders +
      ' · Feedback: ' + d.stats.count + ' · ⭐ ' + (d.stats.average || 0) + '</p><p>Ticket mở: ' + d.openTickets + '</p>' +
      '<pre>' + JSON.stringify(d.byStatus, null, 2) + '</pre></div>';
  }
  if (current === 'orders') {
    const rows = await api('/orders?limit=50');
    v.innerHTML = '<div class="card">' + table(['Mã','Trạng thái','Tổng','Người mua','Tạo'], rows, o =>
      '<td>#' + o.code + '</td><td><span class="pill">' + o.status + '</span></td><td>' + fmt(o.total) + '</td><td>' + o.buyerId + '</td><td>' + dstr(o.createdAt) + '</td>') +
      '</div><div class="card"><div class="row"><input id="ocode" placeholder="Mã đơn" size="8"><input id="oamount" placeholder="Số tiền" size="10"><input id="oref" placeholder="Mã GD" size="14">' +
      '<button class="btn primary" onclick="act(\\'confirm\\')">Xác nhận TT</button>' +
      '<button class="btn" onclick="act(\\'complete\\')">Hoàn thành</button>' +
      '<button class="btn" onclick="act(\\'redeliver\\')">Gửi lại DM</button>' +
      '<button class="btn danger" onclick="act(\\'cancel\\')">Huỷ</button>' +
      '<button class="btn danger" onclick="act(\\'refund\\')">Refund pending</button></div><pre id="odetail"></pre></div>';
    window.act = async (kind) => {
      try {
        const code = $('#ocode').value; const body = {};
        if (kind === 'confirm') { body.amount = Number($('#oamount').value); body.ref = $('#oref').value || undefined; }
        if (kind === 'refund') { body.stage = 'pending'; body.reason = 'refund via dashboard'; }
        if (kind === 'cancel') { body.reason = 'cancelled via dashboard'; }
        const d = await api('/orders/' + code + '/' + kind, { method: 'POST', body: JSON.stringify(body) });
        $('#odetail').textContent = JSON.stringify(d, null, 2); view();
      } catch (e) { err(e); }
    };
  }
  if (current === 'products') {
    const rows = await api('/products?limit=50');
    v.innerHTML = '<div class="card">' + table(['ID','SKU','Tên','Giá','Kho','Trạng thái'], rows, p =>
      '<td>' + p.id + '</td><td>' + p.sku + '</td><td>' + p.name + '</td><td>' + fmt(p.price) + '</td><td>' +
      (p.stockTracked ? p.available : '∞') + '</td><td>' + (p.active ? '🟢' : '🔴') + '</td>') + '</div>' +
      '<div class="card"><h4>Tạo sản phẩm</h4><div class="row"><input id="psku" placeholder="SKU"><input id="pname" placeholder="Tên"><input id="pprice" placeholder="Giá" size="10"><input id="pcat" placeholder="Category ID" size="6"></div>' +
      '<div class="row"><select id="pdel"><option>AUTO</option><option>MANUAL</option></select><button class="btn primary" onclick="createProduct()">Tạo</button></div></div>' +
      '<div class="card"><h4>Nhập kho</h4><div class="row"><input id="iprod" placeholder="Product ID" size="6"></div><textarea id="ilines" rows="5" cols="60" placeholder="Mỗi dòng một key/account hoặc csv sku,secret"></textarea><br><button class="btn primary" onclick="addInv()">Nhập</button> <span id="invres"></span></div>';
    window.createProduct = async () => {
      try { await api('/products', { method: 'POST', body: JSON.stringify({ sku: $('#psku').value, name: $('#pname').value, price: Number($('#pprice').value), categoryId: $('#pcat').value ? Number($('#pcat').value) : null, deliveryMode: $('#pdel').value }) }); view(); } catch (e) { err(e); }
    };
    window.addInv = async () => {
      try { const d = await api('/products/' + $('#iprod').value + '/inventory', { method: 'POST', body: JSON.stringify({ lines: $('#ilines').value }) }); $('#invres').textContent = '✅ ' + d.added + ' dòng'; } catch (e) { err(e); }
    };
  }
  if (current === 'feedback') {
    const rows = await api('/feedback?limit=50');
    v.innerHTML = '<div class="card">' + table(['ID','Đơn','⭐','Nội dung','Trạng thái',''], rows, f =>
      '<td>' + f.id + '</td><td>' + f.orderId + '</td><td>' + f.rating + '</td><td>' + (f.content || '').slice(0, 80) + '</td><td>' + f.status + '</td>' +
      '<td><button class="btn" onclick="fb(\\'hide\\',' + f.id + ')">Ẩn</button><button class="btn" onclick="fb(\\'unhide\\',' + f.id + ')">Bỏ ẩn</button></td>') + '</div>';
    window.fb = async (kind, id) => {
      try { const body = kind === 'hide' ? { reason: 'vi phạm quy tắc' } : {}; await api('/feedback/' + id + '/' + kind, { method: 'POST', body: JSON.stringify(body) }); view(); } catch (e) { err(e); }
    };
  }
  if (current === 'coupons') {
    const rows = await api('/coupons');
    v.innerHTML = '<div class="card">' + table(['Code','Loại','Giá trị','Max','Bật'], rows, c =>
      '<td>' + c.code + '</td><td>' + c.kind + '</td><td>' + c.value + '</td><td>' + (c.maxUses ?? '∞') + '</td><td>' + (c.active ? '🟢' : '🔴') + '</td>') +
      '</div><div class="card"><div class="row"><input id="ccode" placeholder="CODE"><select id="ckind"><option>percent</option><option>fixed</option></select><input id="cvalue" placeholder="Value" size="8"><input id="cmax" placeholder="Max uses" size="6"><button class="btn primary" onclick="cc()">Tạo</button></div></div>';
    window.cc = async () => {
      try { await api('/coupons', { method: 'POST', body: JSON.stringify({ code: $('#ccode').value, kind: $('#ckind').value, value: Number($('#cvalue').value), maxUses: $('#cmax').value ? Number($('#cmax').value) : null }) }); view(); } catch (e) { err(e); }
    };
  }
  if (current === 'tickets') {
    const rows = await api('/tickets?limit=50');
    v.innerHTML = '<div class="card">' + table(['Code','Chủ đề','Trạng thái','Mở'], rows, t =>
      '<td>' + t.code + '</td><td>' + (t.subject || '').slice(0, 60) + '</td><td>' + t.status + '</td><td>' + dstr(t.createdAt) + '</td>') + '</div>';
  }
  if (current === 'staff') {
    const rows = await api('/staff');
    v.innerHTML = '<div class="card">' + table(['User','Vai trò'], rows, s => '<td>' + s.discordId + '</td><td>' + s.role + '</td>') +
      '</div><div class="card"><div class="row"><input id="suid" placeholder="Discord user ID" size="22"><select id="srole">' +
      ['ADMINISTRATOR','FINANCE','PRODUCT_MANAGER','SUPPORT','MODERATOR'].map(r => '<option>' + r + '</option>').join('') +
      '</select><button class="btn primary" onclick="sg()">Cấp</button></div></div>';
    window.sg = async () => {
      try { await api('/staff', { method: 'POST', body: JSON.stringify({ discordId: $('#suid').value, role: $('#srole').value }) }); view(); } catch (e) { err(e); }
    };
  }
  if (current === 'audit') {
    const rows = await api('/audit?limit=100');
    v.innerHTML = '<div class="card">' + table(['Thời gian','Actor','Hành động','Target'], rows, a =>
      '<td>' + dstr(a.createdAt) + '</td><td>' + (a.actorId || a.actorType) + '</td><td>' + a.action + '</td><td>' + (a.targetType || '') + ' ' + (a.targetId || '') + '</td>') + '</div>';
  }
  if (current === 'config') {
    const d = await api('/config');
    v.innerHTML = '<div class="card"><pre>' + JSON.stringify(d, null, 2) + '</pre>' +
      '<div class="row"><input id="ckey" placeholder="channels.feedback" size="24"><input id="cval" placeholder="ID kênh / true / false" size="24"><button class="btn primary" onclick="cs()">Lưu</button></div></div>';
    window.cs = async () => {
      try {
        let value = $('#cval').value;
        if (value === 'true') value = true; else if (value === 'false') value = false; else if (value === 'null') value = null; else if (/^-?\\d+$/.test(value)) value = Number(value);
        const path = $('#ckey').value.split('.');
        const patch = {}; let cur = patch;
        path.forEach((p, i) => { if (i === path.length - 1) cur[p] = value; else cur = cur[p] = {}; });
        await api('/config', { method: 'PATCH', body: JSON.stringify({ patch }) }); view();
      } catch (e) { err(e); }
    };
  }
}
renderNav(); me(); view().catch(err);
</script>
</body>
</html>`;
