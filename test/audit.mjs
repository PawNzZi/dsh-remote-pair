/**
 * 端到端能力审计：全部经 dsh-remote-pair 的桥（8787）走，
 * 验证手机端要用到的每个 remote 都能拿到数据，包括 WS 跟随流。
 */
// 依赖 ws：先在该目录执行 npm i ws（仅测试用，不是插件运行依赖）
import WebSocket from 'ws';

const bridge = 'http://127.0.0.1:8787';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const page = await (await fetch(`${bridge}/pair`)).text();
const url = /(http:\/\/[\d.]+:8787\/\?token=[A-Za-z0-9_-]+)/.exec(page)[1];
const exchange = await fetch(url, { redirect: 'manual' });
const cookie = ((exchange.headers.getSetCookie?.() ?? [exchange.headers.get('set-cookie')])[0] ?? '').split(';')[0];
record('token → Cookie（经桥）', exchange.status === 303 && cookie.startsWith('dsh-auth-'), `status=${exchange.status}`);

async function rpc(method, args) {
  const res = await fetch(`${bridge}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'a' + Math.random().toString(16).slice(2), method, payload: { args } })
  });
  const body = await res.json();
  return body.result;
}

const list = await rpc('session/list', { _request: {} });
record('session/list', list.ok === true, list.ok ? `${list.value.items.length} 个会话` : JSON.stringify(list.error));
const sessionId = list.value.items[0].sessionId;

const catalog = await rpc('session/modelCatalog', {});
record('session/modelCatalog', catalog.ok === true,
  catalog.ok ? `${catalog.value.groups.length} 个模型组` : JSON.stringify(catalog.error));

const presets = await rpc('agentPresets/list', {});
record('agentPresets/list', presets.ok === true,
  presets.ok ? `${(presets.value.presets ?? presets.value.items ?? []).length} 个预设` : JSON.stringify(presets.error));

const skills = await rpc('skills/list', { request: { sessionId } });
record('skills/list', skills.ok === true,
  skills.ok ? `${(skills.value.skills ?? skills.value.items ?? []).length} 个技能` : JSON.stringify(skills.error));

const plugins = await rpc('pluginInventory/list', {});
record('pluginInventory/list', plugins.ok === true,
  plugins.ok ? `${(plugins.value.entries ?? []).length} 个插件` : JSON.stringify(plugins.error));

const perm = await rpc('permissionPresets/catalog', {});
record('permissionPresets/catalog', perm.ok === true,
  perm.ok ? (perm.value.options ?? []).map((o) => o.value).join(' / ') : JSON.stringify(perm.error));

const client = { version: '1', locale: 'zh-CN', timezoneOffsetSeconds: 28800 };
const state = await rpc('account/getState', {});
record('account/getState', state.ok === true, state.ok ? `status=${state.value.status}` : JSON.stringify(state.error));
const balance = await rpc('account/getBalance', { client });
record('account/getBalance', balance.ok === true, balance.ok ? JSON.stringify(balance.value).slice(0, 80) : JSON.stringify(balance.error));
const profile = await rpc('account/getProfile', { client });
record('account/getProfile', profile.ok === true, profile.ok ? JSON.stringify(profile.value).slice(0, 80) : JSON.stringify(profile.error));

const cmds = await rpc('commands/list', { agentId: sessionId });
record('commands/list', cmds.ok === true, cmds.ok ? `${cmds.value.length} 条命令` : JSON.stringify(cmds.error));

// --- WS 跟随流（聊天页的数据源） ---
const frames = await new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:8787/api/remote.mux', { headers: { cookie } });
  const collected = [];
  const timer = setTimeout(() => {
    ws.terminate();
    resolve(collected);
  }, 6000);
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'open',
      streamId: 'audit-follow',
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 200 } } }
    }));
  });
  ws.on('message', (data) => {
    collected.push(JSON.parse(data.toString()));
    const last = collected[collected.length - 1];
    if (last.type === 'end' || last.type === 'error') {
      clearTimeout(timer);
      ws.close();
      resolve(collected);
    }
  });
  ws.on('error', () => {
    clearTimeout(timer);
    resolve(collected);
  });
});
const snapshot = frames.find((f) => f.type === 'item' && JSON.stringify(f.value ?? {}).includes('records'));
const errorFrame = frames.find((f) => f.type === 'error');
record('WS session/follow 帧', frames.length > 0 && errorFrame === undefined,
  errorFrame ? JSON.stringify(errorFrame.error) : `${frames.length} 帧${snapshot ? '（含 snapshot）' : ''}`);

// --- $events 流（审批/提问/状态） ---
const eventFrames = await new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:8787/api/remote.mux', { headers: { cookie } });
  const collected = [];
  const timer = setTimeout(() => {
    ws.terminate();
    resolve(collected);
  }, 4000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'open', streamId: 'audit-events', endpoint: '$events', payload: { args: {} } }));
  });
  ws.on('message', (data) => {
    collected.push(JSON.parse(data.toString()));
    if (collected.some((f) => f.type === 'item' && f.value?.type === 'ready')) {
      clearTimeout(timer);
      ws.close();
      resolve(collected);
    }
  });
  ws.on('error', () => {
    clearTimeout(timer);
    resolve(collected);
  });
});
const ready = eventFrames.find((f) => f.type === 'item' && f.value?.type === 'ready');
record('WS $events ready 帧', ready !== undefined, ready ? `clientId=${String(ready.value.clientId).slice(0, 8)}…` : '未收到');

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
