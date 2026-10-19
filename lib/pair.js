/**
 * 配对信息生成：局域网地址、配对链接、二维码 SVG、`/pair` 页面。
 */
import os from 'node:os';
import qrcode from './qr.cjs';

/** 选一个最可能被手机访问到的局域网 IPv4（优先 192.168 / 10 / 172.16-31）。 */
export function lanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push({ address: info.address, name });
    }
  }
  const isPrivate = (ip) =>
    ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  candidates.sort((a, b) => (isPrivate(b.address) ? 1 : 0) - (isPrivate(a.address) ? 1 : 0));
  return candidates[0]?.address ?? '';
}

/** 生成二维码 SVG（内联到页面里，无需外部资源）。 */
export function qrSvg(text, { cellSize = 6, margin = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * `/pair` 页面：二维码 + 可复制链接。
 * @param {{ url: string, port: number, publicUrl?: string }} input
 */
export function pairHtml(input) {
  const safeUrl = escapeHtml(input.url);
  const svg = qrSvg(input.url);
  const where = input.publicUrl
    ? '当前使用你在配置里填写的公网地址（publicUrl）'
    : '当前使用局域网地址；如果人在外面，请把 publicUrl 配成花生壳/Tailscale 的地址';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配对 DSH 遥控器</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f7f8fa; color: #111827; display: flex; justify-content: center; }
  main { width: 100%; max-width: 560px; padding: 28px 20px 40px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.lead { color: #6b7280; font-size: 13px; line-height: 1.7; margin: 0 0 18px; }
  .card { background: #fff; border-radius: 16px; padding: 18px; box-shadow: 0 2px 12px rgba(15, 23, 42, .06); }
  .qr { display: flex; justify-content: center; padding: 6px 0 14px; }
  .qr svg { width: 260px; height: 260px; }
  code { display: block; word-break: break-all; font-size: 12px; line-height: 1.6;
         background: #f3f4f6; border-radius: 10px; padding: 10px; color: #111827; }
  ol { padding-left: 18px; color: #4b5563; font-size: 13px; line-height: 1.9; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  button { flex: 1; border: 0; border-radius: 10px; padding: 11px 12px; font-size: 13px; cursor: pointer; }
  button.primary { background: #4d6bfe; color: #fff; }
  button.ghost { background: #eef2ff; color: #4d6bfe; }
  .warn { margin-top: 16px; background: #fffbeb; color: #b45309; border-radius: 10px;
          padding: 10px 12px; font-size: 12px; line-height: 1.7; }
  .meta { margin-top: 10px; color: #9ca3af; font-size: 11px; line-height: 1.6; }
</style>
</head>
<body>
<main>
  <h1>配对 DSH 遥控器</h1>
  <p class="lead">用手机上的「DSH 遥控器」扫下面的二维码，或在配对页粘贴这条链接。</p>
  <div class="card">
    <div class="qr">${svg}</div>
    <code id="url">${safeUrl}</code>
    <div class="row">
      <button class="primary" onclick="copyUrl()">复制链接</button>
      <button class="ghost" onclick="location.reload()">刷新二维码</button>
    </div>
    <ol>
      <li>手机和电脑连同一个 Wi-Fi（或使用公网地址）</li>
      <li>打开 App → 配对页 → 点「扫码」扫上面的码</li>
      <li>配对成功后即可看到会话列表</li>
    </ol>
    <div class="warn">这个二维码等同于你桌面端的控制权，不要截图发人、不要投屏共享。</div>
    <div class="meta">${escapeHtml(where)}。本页只在电脑本机可打开（127.0.0.1:${input.port}/pair），令牌不会发到局域网。</div>
  </div>
</main>
<script>
  function copyUrl() {
    const text = document.getElementById('url').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(
      () => { document.querySelector('button.primary').textContent = '已复制'; },
      () => { window.prompt('手动复制：', text); }
    );
    else window.prompt('手动复制：', text);
  }
</script>
</body>
</html>`;
}
