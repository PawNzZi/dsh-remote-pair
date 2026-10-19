/**
 * 本地验证脚本（不需要 DSH 加载插件）：
 *   node test/local-bridge.mjs [targetPort]
 *
 * 用真实桌面版 DSH 的端口做上游，检查：
 *   1. /pair 页面能渲染二维码与链接，且只对本机开放；
 *   2. 匿名请求经桥转发后是 401（到了鉴权层）而不是 403（被 Host 栅栏拦）；
 *   3. 带凭证 Cookie 的 API 请求经桥返回 ok:true；
 *   4. WebSocket Upgrade 能打通（101），即 /api/remote.mux 可用；
 *   5. 顺带把二维码导出成 .tmp/qr-check.png 便于目视检查。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startBridge } from '../lib/bridge.js';
import { pairHtml, lanAddress } from '../lib/pair.js';
import qrcode from '../lib/qr.cjs';

const targetPort = Number.parseInt(process.argv[2] ?? '53458', 10);
const listenPort = 8899;

function credentials() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u.exec(text);
  if (match === null) throw new Error('找不到 browser-session secret');
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

function b64url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function mintCookie(secret, authority) {
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({
    version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000
  }), 'utf8'));
  const signature = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const name = `dsh-auth-${b64url(crypto.createHash('sha256').update(authority).digest())}`;
  return `${name}=v1.${body}.${signature}`;
}

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

function wsHandshake(port, cookie) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Cookie: ${cookie}\r\n\r\n`
      );
    });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: 'timeout' });
    }, 4000);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      if (received.includes('\r\n\r\n')) {
        clearTimeout(timer);
        const status = received.split('\r\n')[0].trim();
        socket.destroy();
        resolve({ ok: status.includes('101'), detail: status });
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
  });
}

function writePng(file, matrix, scale = 6) {
  const size = matrix.length;
  const margin = 4 * scale;
  const width = size * scale + margin * 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * width, 0xff);
  for (let y = 0; y < width; y += 1) raw[y * stride] = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!matrix[row][column]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = margin + column * scale + dx;
          const y = margin + row * scale + dy;
          const at = y * stride + 1 + x * 3;
          raw[at] = 0;
          raw[at + 1] = 0;
          raw[at + 2] = 0;
        }
      }
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

const pairUrl = `http://${lanAddress() || '127.0.0.1'}:${listenPort}/?token=demo-token-for-test`;
const bridge = await startBridge({
  listenHost: '127.0.0.1',
  listenPort,
  targetHost: '127.0.0.1',
  targetPort,
  pairPage: () => pairHtml({ url: pairUrl, port: listenPort })
});
console.log(`bridge on 127.0.0.1:${bridge.port} → 127.0.0.1:${targetPort}`);

try {
  const page = await fetch(`http://127.0.0.1:${bridge.port}/pair`);
  const html = await page.text();
  check('GET /pair 返回 200', page.status === 200, String(page.status));
  check('/pair 含二维码 SVG', html.includes('<svg') && html.includes('</svg>'));
  check('/pair 含配对链接', html.includes('token=demo-token-for-test'));

  const anonymous = await fetch(`http://127.0.0.1:${bridge.port}/`);
  check('匿名 GET / 到鉴权层（401 而非 403）', anonymous.status === 401, String(anonymous.status));

  const authority = `127.0.0.1:${targetPort}`;
  const cookie = mintCookie(credentials(), authority);
  const listed = await fetch(`http://127.0.0.1:${bridge.port}/api/session/list`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'bridge-test', method: 'session/list', payload: { args: { _request: {} } }
    })
  });
  const listedJson = await listed.json();
  check('带 Cookie 的 session/list 经桥成功', listedJson?.result?.ok === true,
    JSON.stringify(listedJson?.result?.error ?? ''));

  const upgrade = await wsHandshake(bridge.port, cookie);
  check('WebSocket Upgrade 经桥打通（101）', upgrade.ok, upgrade.detail);
} finally {
  await bridge.close();
}

const qr = qrcode(0, 'M');
qr.addData(pairUrl, 'Byte');
qr.make();
const count = qr.getModuleCount();
const matrix = Array.from({ length: count }, (_, row) =>
  Array.from({ length: count }, (_, column) => qr.isDark(row, column)));
writePng('.tmp/qr-check.png', matrix);
console.log(`二维码矩阵 ${count}×${count}，已导出 .tmp/qr-check.png`);
