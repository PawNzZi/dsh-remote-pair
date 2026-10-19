/**
 * dsh-remote-pair —— 给「DSH 遥控器」手机端生成配对链接与二维码的 DSH 插件。
 *
 * 为什么需要它：DSH 的 Web 服务只监听 127.0.0.1，桌面版连端口都是随机的，
 * 换证令牌又只保存在 Host 进程内（不打印、不落盘）。手机端拿不到这些信息，
 * 也没法访问 127.0.0.1。本插件在 Host 进程里运行，因此可以：
 *
 *   1. 通过 `ctx.connection.authenticatedUrl()` 直接拿到带 token 的地址；
 *   2. 通过 `ctx.webServer.port` 知道当前实际端口；
 *   3. 自己开一个固定端口的局域网桥（Host 改写 + WebSocket 透传）；
 *   4. 提供 `/pair` 页面（二维码）和 `/pair` 斜杠命令（链接）。
 *
 * 用法：把本包装进对应 profile（web 或 desktop），重启 DSH，然后访问
 * `http://127.0.0.1:8787/pair`，或在会话里发 `/pair`。
 */
import { randomUUID } from 'node:crypto';
import { startBridge } from './bridge.js';
import { lanAddress, pairHtml } from './pair.js';

export const name = 'remote-pair';

/** 需要 Web 服务与连接服务（两者由 dsh-web-app 提供，web/desktop 都有）。 */
export const inject = ['webServer', 'connection'];

function normalize(config) {
  const raw = config ?? {};
  const port = Number.parseInt(String(raw.port ?? 8787), 10);
  return {
    enabled: raw.enabled !== false,
    host: typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : '0.0.0.0',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787,
    publicUrl: typeof raw.publicUrl === 'string' ? raw.publicUrl.trim().replace(/\/+$/, '') : '',
    // true：/pair 把地址交给 Agent，由它在对话里回复一条消息（链接可点）。
    // false：只在命令卡片里显示地址（旧行为）。
    chatReply: raw.chatReply !== false
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（Host 进程）
 * @param {object} config - 插件配置
 */
export function apply(ctx, config) {
  const options = normalize(config);
  if (!options.enabled) {
    ctx.logger?.info?.('[dsh-remote-pair] 已禁用（enabled: false）');
    return;
  }

  const state = { port: options.port, handle: undefined };

  // Host 的 logger 不一定把 info 打到终端，这里同时写一份 console，
  // 保证 `dsh web` 的终端里总能看到桥的地址。
  const log = (message) => {
    const line = `[dsh-remote-pair] ${message}`;
    try {
      ctx.logger?.info?.(line);
    } catch {
      /* logger 不可用就只走 console */
    }
    console.info(line);
  };

  const pairUrl = () => {
    const base = options.publicUrl.length > 0
      ? options.publicUrl
      : `http://${lanAddress() || '127.0.0.1'}:${state.port}`;
    try {
      return ctx.connection.authenticatedUrl(`${base.replace(/\/+$/, '')}/`);
    } catch {
      return `${base}/`;
    }
  };

  ctx.effect(() => {
    let disposed = false;
    const targetPort = ctx.webServer.port;
    startBridge({
      listenHost: options.host,
      listenPort: options.port,
      targetHost: '127.0.0.1',
      targetPort,
      pairPage: () => pairHtml({
        url: pairUrl(),
        port: state.port,
        publicUrl: options.publicUrl
      }),
      log: (message) => log(message)
    }).then((handle) => {
      state.handle = handle;
      state.port = handle.port;
      if (disposed) {
        handle.close();
        return;
      }
      const lan = lanAddress();
      log(`目标 http://127.0.0.1:${targetPort}，桥 http://${options.host}:${handle.port}`);
      log(`二维码页面：http://127.0.0.1:${handle.port}/pair`);
      if (lan.length > 0) {
        log(`手机可访问：http://${lan}:${handle.port}`);
      }
    }).catch((error) => {
      log(`桥启动失败：${error?.message ?? String(error)}`);
    });
    return () => {
      disposed = true;
      state.handle?.close?.();
      state.handle = undefined;
    };
  }, 'dsh-remote-pair: LAN bridge');

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      definitionId: 'dsh-remote-pair',
      name: 'pair',
      description: '显示手机配对链接与二维码页面',
      handler: (invocation) => {
        if (state.handle === undefined) {
          return { kind: 'error', text: '配对桥尚未就绪（端口可能被占用），请查看 Host 日志' };
        }
        const page = `http://127.0.0.1:${state.port}/pair`;
        const link = pairUrl();
        const announced = options.chatReply && announceInConversation(invocation, page, link);
        return {
          kind: 'success',
          text: announced
            ? '配对链接已发送到对话'
            : `二维码页面：${page}\n配对链接：${link}`
        };
      }
    }), 'dsh-remote-pair: /pair command');
  });
}

/**
 * 把配对地址作为一条会话消息交给 Agent，让它在对话里回复给用户。
 *
 * 斜杠命令的结果只显示在命令卡片里（纯文本），所以这里用 Agent 的
 * `followup()` 投递一条上下文消息并唤醒一轮对话：模型看到要回复的内容后，
 * 会在对话中正常输出一条带链接的消息（Markdown 里的链接可点击）。
 *
 * @param {object} invocation - 命令调用（带 agent）
 * @param {string} page - 二维码页面地址
 * @param {string} link - 手机配对链接（带 token）
 * @returns {boolean} 是否已投递
 */
function announceInConversation(invocation, page, link) {
  const agent = invocation?.agent;
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') return false;
  const text = [
    '用户刚执行了 /pair 命令。请把下面两行原样回复给用户，不要添加其他内容，不要使用代码块：',
    '',
    `二维码页面：${page}`,
    `手机配对链接：${link}`
  ].join('\n');
  try {
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-remote-pair', form: 'notice', summary: '配对链接已生成' }
    });
    return true;
  } catch {
    return false;
  }
}
