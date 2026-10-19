/**
 * dsh-remote-pair · 局域网配对桥
 *
 * DSH 的 Web 服务只监听 127.0.0.1，且 `/api` 有一道 Host 栅栏（Host 必须是回环、
 * 绑定 IP 或 trustedHosts）。手机在局域网里访问不到 127.0.0.1，直连还会被 403。
 *
 * 这个桥做三件事：
 *   1. 监听一个固定端口（默认 8787，可被局域网访问）；
 *   2. 把每个请求的 Host 改写成 `127.0.0.1:<目标端口>`，并剥掉 Origin / Sec-Fetch-*；
 *   3. WebSocket Upgrade 也原样透传（`/api/remote.mux` 必须）。
 *
 * 另外提供一个 `/pair` 页面（只允许本机访问），显示二维码与可复制链接。
 */
import http from 'node:http';
import net from 'node:net';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

function rewriteHeaders(headers, targetHost, targetPort) {
  const out = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'origin' || lower.startsWith('sec-fetch-')) continue;
    if (lower === 'host' || HOP_BY_HOP.has(lower)) continue;
    out[lower] = value;
  }
  out.host = `${targetHost}:${targetPort}`;
  return out;
}

function handleHttp(req, res, options) {
  const path = (req.url ?? '/').split('?')[0];
  if (options.pairPage !== undefined && (path === '/pair' || path === '/pair/')) {
    if (!isLoopback(req)) {
      // 配对页里带着令牌，只允许在电脑本机打开。
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('请在电脑本机浏览器打开 http://127.0.0.1:' + options.listenPort + '/pair\n');
      return;
    }
    const html = options.pairPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  const upstream = http.request({
    host: options.targetHost,
    port: options.targetPort,
    method: req.method,
    path: req.url,
    headers: rewriteHeaders(req.headers, options.targetHost, options.targetPort)
  }, (answer) => {
    const pass = {};
    for (const [name, value] of Object.entries(answer.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) pass[name] = value;
    }
    res.writeHead(answer.statusCode ?? 502, pass);
    answer.pipe(res);
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`dsh-remote-pair: 上游 ${options.targetHost}:${options.targetPort} 不可用：${error.message}\n`);
  });
  req.pipe(upstream);
}

function handleUpgrade(req, socket, head, options) {
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  const headers = rewriteHeaders(req.headers, options.targetHost, options.targetPort);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade ?? 'websocket';
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
    else lines.push(`${name}: ${value}`);
  }
  const upstream = net.connect(options.targetPort, options.targetHost, () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const teardown = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', teardown);
  socket.on('error', teardown);
  socket.on('close', teardown);
}

/**
 * 启动桥。端口被占用时自动往后找（最多 tries 个）。
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startBridge(options) {
  const {
    listenHost = '0.0.0.0',
    listenPort = 8787,
    targetHost = '127.0.0.1',
    targetPort,
    pairPage,
    tries = 10,
    log = () => {}
  } = options;
  if (!Number.isInteger(targetPort) || targetPort <= 0) {
    throw new Error('dsh-remote-pair: 目标端口无效');
  }

  let lastError;
  for (let offset = 0; offset < tries; offset += 1) {
    const port = listenPort + offset;
    const resolved = Object.assign({}, options, { listenPort: port, targetHost, targetPort, pairPage, log });
    const server = http.createServer((req, res) => handleHttp(req, res, resolved));
    server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, resolved));
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, listenHost, () => {
          server.off('error', reject);
          resolve();
        });
      });
      log(`bridge listening on ${listenHost}:${port} → ${targetHost}:${targetPort}`);
      return {
        port,
        server,
        close: () => new Promise((resolve) => server.close(() => resolve()))
      };
    } catch (error) {
      lastError = error;
      try {
        server.close();
      } catch {
        /* 已经关闭 */
      }
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('dsh-remote-pair: 没有可用端口');
}
