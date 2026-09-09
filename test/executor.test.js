const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { createLogger, formatBeijingTimestamp } = require('../src/logger');
const { createRuisiClient } = require('../src/ruisi-client');
const { PollingRunner } = require('../src/polling-runner');
const script = require('../src/scripts/messages');
const { AGENT, TO } = require('../src');

function loggerCapture() { const entries = []; return { entries, info: (message, details) => entries.push({ level: 'info', message, details }), error: (message, details) => entries.push({ level: 'error', message, details }) }; }
async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${instance.address().port}/agent/send`, close: () => new Promise((resolve) => instance.close(resolve)) };
}
function readJson(req) { return new Promise((resolve, reject) => { let text = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { text += chunk; }); req.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); req.on('error', reject); }); }

test('配置校验并按 host、port 生成固定回程 URL', () => {
  assert.deepEqual(readConfig({ INGRESS_HOST: '127.0.0.1', INGRESS_PORT: '29876', INGRESS_TOKEN: 'test' }), { ingressHost: '127.0.0.1', ingressPort: 29876, ingressToken: 'test', ingressTimeoutMs: 5000, ingressUrl: 'http://127.0.0.1:29876/agent/send' });
  assert.throws(() => readConfig({ INGRESS_HOST: '127.0.0.1', INGRESS_PORT: 'bad', INGRESS_TOKEN: 'test' }), /INGRESS_PORT/);
  assert.throws(() => readConfig({ INGRESS_HOST: '127.0.0.1', INGRESS_PORT: '1' }), /INGRESS_TOKEN/);
});

test('一个完整轮次向 Mock 依次发送安防映射、header 和三条剧本', async () => {
  const requests = [];
  const mock = await server(async (req, res) => { requests.push({ method: req.method, headers: req.headers, body: await readJson(req) }); res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok","sent":true}'); });
  try {
    const waits = []; const log = loggerCapture();
    const client = createRuisiClient({ ingressUrl: mock.url, authToken: 'test-token', timeoutMs: 1000, logger: log });
    await new PollingRunner({ agent: AGENT, to: TO, script, client, logger: log, sleep: async (ms) => { waits.push(ms); } }).run({ maxRounds: 1 });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.body), script.messages.map((message) => ({ agent: 'xslatdzp.SecOpsAgent', to: 'xslatdzp.demo001@rscom-chat.rsagent.net', body: message.body, groupchat: false })));
    for (const request of requests) { assert.equal(request.method, 'POST'); assert.match(request.headers['content-type'], /application\/json/); assert.equal(request.headers['x-auth-token'], 'test-token'); }
    assert.deepEqual(waits, [script.initialDelayMs, script.messages[0].delayAfterMs, script.defaultMessageIntervalMs]);
  } finally { await mock.close(); }
});

test('HTTP 失败不会中断本轮后续消息', async () => {
  const calls = []; const log = loggerCapture();
  const runner = new PollingRunner({ agent: AGENT, to: TO, script: { initialDelayMs: 0, defaultMessageIntervalMs: 0, roundIntervalMs: 0, messages: [{ body: 'first' }, { body: 'second' }] }, logger: log, sleep: async () => {}, client: { sendMessage: async ({ body }) => { calls.push(body); return body === 'first' ? { ok: false, status: 503, error: 'unavailable' } : { ok: true, status: 200 }; } } });
  await runner.run({ maxRounds: 1 });
  assert.deepEqual(calls, ['first', 'second']);
  assert.ok(log.entries.some((entry) => entry.message.includes('继续后续轮询')));
});

test('非 2xx 由 HTTP client 返回受控失败，不抛出未处理异常', async () => {
  const mock = await server((req, res) => res.writeHead(503).end());
  try { assert.deepEqual(await createRuisiClient({ ingressUrl: mock.url, authToken: 'test-token' }).sendMessage({ agent: AGENT, to: TO, body: 'test', groupchat: false }), { ok: false, status: 503, error: 'RUISI ingress failed with status 503' }); } finally { await mock.close(); }
});

test('日志保持北京时间 HH:mm:ss 格式且 token 脱敏', () => {
  assert.equal(formatBeijingTimestamp(new Date('2026-08-25T03:35:05.281Z')), '2026-08-25 11:35:05');
  const lines = []; createLogger({ log: (line) => lines.push(line) }).info('test', { ingressToken: 'must-not-appear' });
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[信息\]/); assert.doesNotMatch(lines[0], /must-not-appear/);
});

test('stop 会取消等待，且不会调度新消息', async () => {
  const calls = [];
  const runner = new PollingRunner({ agent: AGENT, to: TO, script: { initialDelayMs: 60000, defaultMessageIntervalMs: 0, roundIntervalMs: 0, messages: [{ body: 'must-not-send' }] }, client: { sendMessage: async () => { calls.push('sent'); return { ok: true, status: 200 }; } } });
  const running = runner.run();
  await new Promise((resolve) => setImmediate(resolve));
  runner.stop();
  await running;
  assert.deepEqual(calls, []);
});
