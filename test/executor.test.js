const http = require('node:http');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../src/config');
const { createLogger, formatBeijingTimestamp } = require('../src/logger');
const { createRuisiClient } = require('../src/ruisi-client');
const { PollingRunner } = require('../src/polling-runner');
const script = require('../src/scripts/messages');
const { TO, start, installShutdownHandlers } = require('../src');

const TEST_AGENT = 'rs-demorg-secops';

function loggerCapture() {
  const entries = [];
  return {
    entries,
    info: (message, details) => entries.push({ level: 'info', message, details }),
    error: (message, details) => entries.push({ level: 'error', message, details })
  };
}

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${instance.address().port}/agent/send`,
    close: () => new Promise((resolve) => instance.close(resolve))
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function createRunner(options = {}) {
  return new PollingRunner({
    agent: options.agent || TEST_AGENT,
    to: TO,
    script: options.script || script,
    client: options.client || { sendMessage: async () => ({ ok: true, status: 200 }) },
    logger: options.logger || loggerCapture(),
    sleep: options.sleep,
    subjectName: '安防智能体'
  });
}

test('配置校验并按 host、port 生成固定回程 URL', () => {
  const baseEnv = { AGENT: TEST_AGENT, INGRESS_HOST: '127.0.0.1', INGRESS_PORT: '29876', INGRESS_TOKEN: 'test' };
  assert.deepEqual(
    readConfig(baseEnv),
    { agent: TEST_AGENT, port: 18031, ingressHost: '127.0.0.1', ingressPort: 29876, ingressToken: 'test', ingressTimeoutMs: 5000, ingressUrl: 'http://127.0.0.1:29876/agent/send' }
  );
  assert.equal(readConfig({ ...baseEnv, AGENT: 'overridden-agent' }).agent, 'overridden-agent');
  assert.throws(() => readConfig({ INGRESS_HOST: '127.0.0.1', INGRESS_PORT: '29876', INGRESS_TOKEN: 'test' }), /AGENT/);
  assert.equal(readConfig({ ...baseEnv, PORT: '24000' }).port, 24000);
  assert.throws(() => readConfig({ ...baseEnv, PORT: 'invalid' }), /PORT/);
  assert.throws(() => readConfig({ AGENT: TEST_AGENT, INGRESS_HOST: '127.0.0.1', INGRESS_PORT: 'bad', INGRESS_TOKEN: 'test' }), /INGRESS_PORT/);
  assert.throws(() => readConfig({ AGENT: TEST_AGENT, INGRESS_HOST: '127.0.0.1', INGRESS_PORT: '1' }), /INGRESS_TOKEN/);
});

test('段落01第1条启动后立即发送，不先 sleep(0)', async () => {
  const calls = [];
  const waits = [];
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['first'] }] },
    client: { sendMessage: async ({ body }) => { calls.push(body); return { ok: true, status: 200 }; } },
    sleep: async (ms) => { waits.push(ms); }
  });
  await runner.run({ maxRounds: 1 });
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(waits, [720000]);
});

test('三消息段落只在相邻消息间等待40秒，末条后等待12分钟', async () => {
  const events = [];
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['one', 'two', 'three'] }] },
    client: { sendMessage: async ({ body }) => { events.push(`send:${body}`); return { ok: true, status: 200 }; } },
    sleep: async (ms) => { events.push(`sleep:${ms}`); }
  });
  await runner.run({ maxRounds: 1 });
  assert.deepEqual(events, ['send:one', 'sleep:40000', 'send:two', 'sleep:40000', 'send:three', 'sleep:720000']);
});

test('两消息段落末条到下一段首条之间仅等待12分钟', async () => {
  const events = [];
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['one', 'two'] }, { id: '02', messages: ['three'] }] },
    client: { sendMessage: async ({ body }) => { events.push(`send:${body}`); return { ok: true, status: 200 }; } },
    sleep: async (ms) => { events.push(`sleep:${ms}`); }
  });
  await runner.run({ maxRounds: 1 });
  assert.deepEqual(events.slice(0, 4), ['send:one', 'sleep:40000', 'send:two', 'sleep:720000']);
  assert.equal(events[4], 'send:three');
});

test('段落12在12分钟后回到段落01，不叠加额外等待', async () => {
  const sent = [];
  const waits = [];
  const paragraphs = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1).padStart(2, '0'), messages: [String(index + 1)] }));
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs },
    client: { sendMessage: async ({ paragraphId }) => { sent.push(paragraphId); return { ok: true, status: 200 }; } },
    sleep: async (ms) => { waits.push(ms); }
  });
  await runner.run({ maxRounds: 2 });
  assert.deepEqual(sent.slice(0, 13), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '01']);
  assert.ok(waits.every((ms) => ms === 720000));
  assert.equal(waits.length, 24);
});

test('正式剧本完整顺序、数量与完整周期均正确', async () => {
  const sent = [];
  const waits = [];
  const runner = createRunner({
    client: { sendMessage: async (message) => { sent.push(message); return { ok: true, status: 200 }; } },
    sleep: async (ms) => { waits.push(ms); }
  });
  await runner.run({ maxRounds: 1 });
  const expected = script.paragraphs.flatMap((paragraph) => paragraph.messages.map((body, index) => ({
    paragraphId: paragraph.id, body, messageIndex: index + 1, messageCount: paragraph.messages.length
  })));
  assert.equal(script.paragraphs.length, 12);
  assert.equal(expected.length, 28);
  assert.deepEqual(
    sent.map(({ paragraphId, body, messageIndex, messageCount }) => ({ paragraphId, body, messageIndex, messageCount })),
    expected
  );
  assert.equal(waits.filter((ms) => ms === 40000).length, 16);
  assert.equal(waits.filter((ms) => ms === 720000).length, 12);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 9280000);
});

test('Mock 回程逐条收到正式安防文案、固定映射与协议字段', async () => {
  const requests = [];
  const mock = await server(async (req, res) => {
    requests.push({ method: req.method, headers: req.headers, body: await readJson(req) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok","sent":true}');
  });
  try {
    const client = createRuisiClient({ ingressUrl: mock.url, authToken: 'test-token', timeoutMs: 1000 });
    await createRunner({ client, sleep: async () => {} }).run({ maxRounds: 1 });
    const expectedBodies = script.paragraphs.flatMap((paragraph) => paragraph.messages);
    assert.equal(requests.length, 28);
    assert.deepEqual(requests.map((request) => request.body), expectedBodies.map((body) => ({
      agent: TEST_AGENT, to: 'xslatdzp.demo001@rscom-chat.rsagent.net', body, groupchat: false
    })));
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.match(request.headers['content-type'], /application\/json/);
      assert.equal(request.headers['x-auth-token'], 'test-token');
    }
  } finally {
    await mock.close();
  }
});

test('单条HTTP失败后仍按正式时序完成后续段落', async () => {
  const sent = [];
  const log = loggerCapture();
  const runner = createRunner({
    logger: log,
    client: {
      sendMessage: async (message) => {
        sent.push(message);
        return sent.length === 1 ? { ok: false, status: 503, error: 'unavailable' } : { ok: true, status: 200 };
      }
    },
    sleep: async () => {}
  });
  await runner.run({ maxRounds: 1 });
  assert.equal(sent.length, 28);
  assert.equal(sent.at(-1).paragraphId, '12');
  assert.ok(log.entries.some((entry) => entry.message.includes('继续后续轮询')));
});

test('stop 在40秒等待中会取消等待且不再发送后续消息', async () => {
  const sent = [];
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['one', 'two'] }] },
    client: { sendMessage: async ({ body }) => { sent.push(body); return { ok: true, status: 200 }; } }
  });
  const running = runner.run();
  await new Promise((resolve) => setImmediate(resolve));
  runner.stop();
  await running;
  assert.deepEqual(sent, ['one']);
});

test('日志保持北京时间 HH:mm:ss 格式且 token 脱敏', () => {
  assert.equal(formatBeijingTimestamp(new Date('2026-08-25T03:35:05.281Z')), '2026-08-25 11:35:05');
  const lines = [];
  createLogger({ log: (line) => lines.push(line) }).info('test', { ingressToken: 'must-not-appear' });
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[信息\]/);
  assert.doesNotMatch(lines[0], /must-not-appear/);
});

function createTestConfig(port) {
  return {
    agent: TEST_AGENT,
    port,
    ingressHost: '127.0.0.1',
    ingressPort: 29876,
    ingressToken: 'test-token',
    ingressTimeoutMs: 1000,
    ingressUrl: 'http://127.0.0.1:29876/agent/send'
  };
}

function createControllableRunner() {
  let resolveRun;
  let resolveStopped;

  const runner = {
    started: 0,
    stopped: 0,
    stoppedPromise: new Promise((resolve) => { resolveStopped = resolve; }),
    run() {
      this.started += 1;
      return new Promise((resolve) => { resolveRun = resolve; });
    },
    stop() {
      this.stopped += 1;
      resolveStopped();
      resolveRun();
    }
  };

  return runner;
}

async function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

async function requestJson(port, method, path, payload) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = body === null ? {} : { 'Content-Type': 'application/json' };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      response.setEncoding('utf8');
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(responseBody) }));
    });
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

async function requestRaw(port, method, path, text) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, (response) => {
      response.setEncoding('utf8');
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(responseBody) }));
    });
    request.on('error', reject);
    request.write(text);
    request.end();
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bindPort(port) {
  const instance = http.createServer();
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(port, () => {
      instance.removeListener('error', reject);
      resolve();
    });
  });
  return instance;
}

test('启动后仅监听 HTTP 服务，不自动创建 Polling Runner，/health 可用', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runners = [];
  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => { const runner = createControllableRunner(); runners.push(runner); return runner; }
  });

  try {
    assert.equal(running.server.address().port, port);
    assert.equal(running.config.agent, TEST_AGENT);
    assert.equal(runners.length, 0);
    assert.deepEqual(await requestHealth(port), { statusCode: 200, body: JSON.stringify({ status: 'ok' }) });
  } finally {
    await running.shutdown('test');
  }
});

test('执行器启动后不自动发起任何 RUISI 回程请求', async () => {
  const requests = [];
  const mock = await server(async (req, res) => {
    requests.push(await readJson(req));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok","sent":true}');
  });
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => createRuisiClient({ ingressUrl: mock.url, authToken: 'test-token', timeoutMs: 1000 })
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(requests.length, 0);
    assert.deepEqual(await requestHealth(port), { statusCode: 200, body: JSON.stringify({ status: 'ok' }) });
  } finally {
    await running.shutdown('test');
    await mock.close();
  }
});

test('POST /api/commands 启动指令开启轮询且重复调用只创建一个 Runner', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runners = [];
  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => { const runner = createControllableRunner(); runners.push(runner); return runner; }
  });

  try {
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: {} }]), {
      statusCode: 200,
      body: { ok: true, message: 'polling started' }
    });
    assert.equal(runners.length, 1);
    assert.equal(runners[0].started, 1);

    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: {} }]), {
      statusCode: 200,
      body: { ok: true, message: 'polling already running' }
    });
    assert.equal(runners.length, 1);
    assert.equal(runners[0].started, 1);
  } finally {
    await running.shutdown('test');
  }
});

test('POST /api/commands 取消指令停止后 HTTP 保持可用，再次启动创建新 Runner', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runners = [];
  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => { const runner = createControllableRunner(); runners.push(runner); return runner; }
  });

  try {
    await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: {} }]);

    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '取消园区AI安防智能体', params: {} }]), {
      statusCode: 200,
      body: { ok: true, message: 'polling stopped' }
    });
    assert.equal(runners[0].stopped, 1);

    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '取消园区AI安防智能体', params: {} }]), {
      statusCode: 200,
      body: { ok: true, message: 'polling already stopped' }
    });
    assert.deepEqual(await requestHealth(port), { statusCode: 200, body: JSON.stringify({ status: 'ok' }) });

    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: {} }]), {
      statusCode: 200,
      body: { ok: true, message: 'polling started' }
    });
    assert.equal(runners.length, 2);
    assert.equal(runners[1].started, 1);
  } finally {
    await running.shutdown('test');
  }
});

test('取消指令停止后不再产生新的回程请求，且在途请求先完成', async () => {
  const requests = [];
  let releaseResponse = null;
  const mock = await server(async (req, res) => {
    requests.push(await readJson(req));
    releaseResponse = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok","sent":true}');
    };
  });
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => createRuisiClient({ ingressUrl: mock.url, authToken: 'test-token', timeoutMs: 1000 }),
    createPollingRunnerFn: (options) => new PollingRunner({
      ...options,
      script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['one', 'two', 'three'] }] },
      sleep: async () => {}
    })
  });

  try {
    await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: {} }]);
    await waitFor(() => requests.length === 1);

    const stopRequest = requestJson(port, 'POST', '/api/commands', [{ action: '取消园区AI安防智能体', params: {} }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, 1);

    releaseResponse();
    assert.deepEqual(await stopRequest, {
      statusCode: 200,
      body: { ok: true, message: 'polling stopped' }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 1);
    assert.deepEqual(await requestHealth(port), { statusCode: 200, body: JSON.stringify({ status: 'ok' }) });
  } finally {
    await running.shutdown('test');
    await mock.close();
  }
});

test('未知 action 不会误启动或误停止轮询', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runners = [];
  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => { const runner = createControllableRunner(); runners.push(runner); return runner; }
  });

  try {
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI不存在的智能体', params: {} }]), {
      statusCode: 400,
      body: { ok: false, error: 'command at index 0 action is not registered' }
    });
    assert.equal(runners.length, 0);

    await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: {} }]);
    assert.equal(runners.length, 1);

    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [
      { action: '启动园区AI安防智能体', params: {} },
      { action: '停止轮询', params: {} }
    ]), {
      statusCode: 400,
      body: { ok: false, error: 'command at index 1 action is not registered' }
    });
    assert.equal(runners.length, 1);
    assert.equal(runners[0].stopped, 0);
    assert.deepEqual(await requestHealth(port), { statusCode: 200, body: JSON.stringify({ status: 'ok' }) });
  } finally {
    await running.shutdown('test');
  }
});

test('异常请求返回合理错误且不改变轮询状态', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const runners = [];
  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => { const runner = createControllableRunner(); runners.push(runner); return runner; }
  });

  try {
    assert.deepEqual(await requestRaw(port, 'POST', '/api/commands', 'not-json'), {
      statusCode: 400, body: { ok: false, error: 'invalid JSON request body' }
    });
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', []), {
      statusCode: 400, body: { ok: false, error: 'request body must not be empty' }
    });
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', { action: '启动园区AI安防智能体' }), {
      statusCode: 400, body: { ok: false, error: 'request body must be an array or context envelope' }
    });
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{}]), {
      statusCode: 400, body: { ok: false, error: 'command at index 0 must include a non-empty string action' }
    });
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', [{ action: '启动园区AI安防智能体', params: [] }]), {
      statusCode: 400, body: { ok: false, error: 'command at index 0 params must be a plain object' }
    });
    assert.deepEqual(await requestJson(port, 'GET', '/api/commands'), {
      statusCode: 405, body: { ok: false, error: 'method not allowed' }
    });
    assert.deepEqual(await requestJson(port, 'GET', '/api/unknown'), {
      statusCode: 404, body: { status: 'not_found' }
    });
    assert.equal(runners.length, 0);
  } finally {
    await running.shutdown('test');
  }
});

test('兼容 context 信封请求体', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => createControllableRunner()
  });

  try {
    assert.deepEqual(await requestJson(port, 'POST', '/api/commands', {
      context: { agent: 'hc-agent' },
      commands: [{ action: '取消园区AI安防智能体', params: {} }]
    }), {
      statusCode: 200, body: { ok: true, message: 'polling already stopped' }
    });
  } finally {
    await running.shutdown('test');
  }
});

test('stop({ abortInFlight: false }) 等待在途请求完成且不再发送后续消息', async () => {
  let resolveSend;
  let sendCount = 0;
  const client = {
    sendMessage: () => {
      sendCount += 1;
      return new Promise((resolve) => { resolveSend = () => resolve({ ok: true, status: 200 }); });
    }
  };
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['one', 'two'] }] },
    client,
    sleep: async () => {}
  });
  const running = runner.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendCount, 1);

  runner.stop({ abortInFlight: false });
  assert.equal(runner.activeController.signal.aborted, false);

  resolveSend();
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendCount, 1);
});

test('stop() 默认中止在途请求并结束轮询', async () => {
  let capturedSignal;
  let sendCount = 0;
  const client = {
    sendMessage: ({ signal }) => {
      sendCount += 1;
      capturedSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, cancelled: true }), { once: true });
      });
    }
  };
  const runner = createRunner({
    script: { initialDelayMs: 0, defaultMessageIntervalMs: 40000, paragraphIntervalMs: 720000, paragraphs: [{ id: '01', messages: ['one', 'two'] }] },
    client,
    sleep: async () => {}
  });
  const running = runner.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendCount, 1);

  runner.stop();
  assert.equal(capturedSignal.aborted, true);
  await running;
  assert.equal(sendCount, 1);
});

test('端口被占用时启动失败，Polling Runner 不会启动', async () => {
  const blocker = await bindPort(0);
  const port = blocker.address().port;
  let runnerCreated = false;

  try {
    await assert.rejects(
      start({
        logger: loggerCapture(),
        loadConfigFn: () => createTestConfig(port),
        createRuisiClientFn: () => ({}),
        createPollingRunnerFn: () => { runnerCreated = true; return createControllableRunner(); }
      }),
      /EADDRINUSE/
    );
    assert.equal(runnerCreated, false);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test('收到 ' + signal + ' 后停止轮询并释放监听端口', async () => {
    const probe = await bindPort(0);
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const runner = createControllableRunner();
    const running = await start({
      logger: loggerCapture(),
      loadConfigFn: () => createTestConfig(port),
      createRuisiClientFn: () => ({}),
      createPollingRunnerFn: () => runner
    });
    await running.controller.start();
    assert.equal(runner.started, 1);
    const processRef = new EventEmitter();
    const shutdownHandlers = installShutdownHandlers({ running, logger: loggerCapture(), processRef });

    processRef.emit(signal);
    await runner.stoppedPromise;
    await shutdownHandlers.shutdown(signal);

    assert.equal(runner.stopped, 1);
    const rebound = await bindPort(port);
    await new Promise((resolve) => rebound.close(resolve));
  });
}

test('未开启轮询时收到 SIGTERM 仍释放监听端口', async () => {
  const probe = await bindPort(0);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const running = await start({
    logger: loggerCapture(),
    loadConfigFn: () => createTestConfig(port),
    createRuisiClientFn: () => ({}),
    createPollingRunnerFn: () => createControllableRunner()
  });
  const processRef = new EventEmitter();
  const shutdownHandlers = installShutdownHandlers({ running, logger: loggerCapture(), processRef });

  processRef.emit('SIGTERM');
  await shutdownHandlers.shutdown('SIGTERM');

  const rebound = await bindPort(port);
  await new Promise((resolve) => rebound.close(resolve));
});
