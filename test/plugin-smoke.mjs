/**
 * 插件装配冒烟测试（不启动 DSH）：
 *   node test/plugin-smoke.mjs [targetPort]
 *
 * 用假的 ctx 调 apply()，验证：
 *   1. 桥按配置端口启动；
 *   2. /pair 页面里的链接带 token（来自 connection.authenticatedUrl）；
 *   3. /pair 斜杠命令注册成功且返回链接；
 *   4. dispose 会关闭桥。
 */
import { apply } from '../lib/index.js';

const targetPort = Number.parseInt(process.argv[2] ?? '53458', 10);
const listenPort = 8898;

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

const disposers = [];
let registeredCommand;

const fakeCtx = {
  webServer: { port: targetPort },
  connection: {
    authenticatedUrl: (base) => `${base}?token=smoke-token`
  },
  logger: {
    info: (message) => console.log('  log:', message),
    error: (message) => console.log('  error:', message)
  },
  effect: (fn) => {
    const dispose = fn();
    disposers.push(dispose);
    return dispose;
  },
  inject: (_deps, callback) => callback(fakeCtx),
  commands: {
    register: (definition) => {
      registeredCommand = definition;
      return () => {
        registeredCommand = undefined;
      };
    }
  }
};

apply(fakeCtx, { port: listenPort, publicUrl: '' });
await new Promise((resolve) => setTimeout(resolve, 400));

const page = await fetch(`http://127.0.0.1:${listenPort}/pair`);
const html = await page.text();
check('/pair 可访问', page.status === 200, String(page.status));
check('/pair 链接带 token', html.includes('token=smoke-token'));
check('/pair 含二维码', html.includes('<svg'));

check('/pair 命令已注册', registeredCommand?.name === 'pair', registeredCommand?.name ?? 'none');
const answer = registeredCommand?.handler?.({ rawInput: '' });
check('命令返回配对链接', answer?.text?.includes('token=smoke-token') === true,
  (answer?.text ?? '').split('\n')[0]);

for (const dispose of disposers.reverse()) {
  if (typeof dispose === 'function') dispose();
}
await new Promise((resolve) => setTimeout(resolve, 200));

const closed = await fetch(`http://127.0.0.1:${listenPort}/pair`).then(() => false, () => true);
check('dispose 后桥已关闭', closed);
