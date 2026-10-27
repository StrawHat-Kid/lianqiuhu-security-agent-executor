const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readHallConfig, findSharedRecipients } = require('../src/config');
const { parseTokenMap, resolveExhibitionId } = require('../src/hall-auth');
const { PollingRunner } = require('../src/polling-runner');
const { start, POLLING_START_ACTION, POLLING_CANCEL_ACTION } = require('../src');

const TOKEN_A = 'token-a-0123456789abcdef';
const TOKEN_B = 'token-b-0123456789abcdef';
const TOKEN_C = 'token-c-0123456789abcdef';
const AGENT_A = 'rs-demorg-secops';
const AGENT_B = 'rs-demorg-secops-b';
const AGENT_C = 'rs-demorg-secops-c';
const HALL_A = 'exhibition-a';
const HALL_B = 'exhibition-b';
const HALL_C = 'exhibition-c';

function buildEnv(overrides = {}) {
  return {
    PORT: '18031',
    HC_TOKEN_MAP: `${TOKEN_A}:${HALL_A},${TOKEN_B}:${HALL_B}`,
    HC_HALL_EXHIBITION_A_AGENT: AGENT_A,
    HC_HALL_EXHIBITION_A_INGRESS_HOST: '127.0.0.1',
    HC_HALL_EXHIBITION_A_INGRESS_PORT: '31001',
    HC_HALL_EXHIBITION_A_INGRESS_TOKEN: 'out-token-a',
    HC_HALL_EXHIBITION_B_AGENT: AGENT_B,
    HC_HALL_EXHIBITION_B_INGRESS_HOST: '127.0.0.1',
    HC_HALL_EXHIBITION_B_INGRESS_PORT: '31002',
    HC_HALL_EXHIBITION_B_INGRESS_TOKEN: 'out-token-b',
    ...overrides
  };
}

test('多展厅配置按 Token 解析出各自的 AGENT 与 INGRESS_PORT', () => {
  const config = readHallConfig(buildEnv());
  assert.equal(config.halls.size, 2);
  assert.equal(config.halls.get(HALL_A).agent, AGENT_A);
  assert.equal(config.halls.get(HALL_A).ingressPort, 31001);
  assert.equal(config.halls.get(HALL_A).ingressUrl, 'http://127.0.0.1:31001/agent/send');
  assert.equal(config.halls.get(HALL_B).agent, AGENT_B);
  assert.equal(config.halls.get(HALL_B).ingressPort, 31002);
  assert.equal(config.tokenMap.get(TOKEN_A), HALL_A);
  assert.equal(config.tokenMap.get(TOKEN_B), HALL_B);
});

function buildThreeHallEnv(overrides = {}) {
  return buildEnv({
    HC_TOKEN_MAP: `${TOKEN_A}:${HALL_A},${TOKEN_B}:${HALL_B},${TOKEN_C}:${HALL_C}`,
    HC_HALL_EXHIBITION_C_AGENT: AGENT_C,
    HC_HALL_EXHIBITION_C_INGRESS_HOST: '127.0.0.1',
    HC_HALL_EXHIBITION_C_INGRESS_PORT: '31003',
    HC_HALL_EXHIBITION_C_INGRESS_TOKEN: 'out-token-c',
    ...overrides
  });
}

test('A/B/C 三个展厅各自解析出 Agent、回程端口与回程 Token', () => {
  const config = readHallConfig(buildThreeHallEnv());
  assert.equal(config.halls.size, 3);
  assert.deepEqual(
    [...config.halls.values()].map((hall) => [hall.hallId, hall.agent, hall.ingressPort, hall.ingressToken]),
    [
      [HALL_A, AGENT_A, 31001, 'out-token-a'],
      [HALL_B, AGENT_B, 31002, 'out-token-b'],
      [HALL_C, AGENT_C, 31003, 'out-token-c']
    ]
  );
  assert.equal(config.tokenMap.get(TOKEN_C), HALL_C);
});

test('缺少第三个展厅配置时启动失败，不回退到默认展厅', () => {
  assert.throws(
    () => readHallConfig(buildThreeHallEnv({ HC_HALL_EXHIBITION_C_AGENT: '' })),
    /HC_HALL_EXHIBITION_C_AGENT/
  );
  assert.throws(
    () => readHallConfig(buildThreeHallEnv({ HC_HALL_EXHIBITION_C_INGRESS_PORT: '' })),
    /HC_HALL_EXHIBITION_C_INGRESS_PORT/
  );
});

test('多展厅配置必须显式提供每个展厅的变量，不做跨展厅默认回退', () => {
  const env = buildEnv({ HC_HALL_EXHIBITION_B_AGENT: '' });
  assert.throws(() => readHallConfig(env), /HC_HALL_EXHIBITION_B_AGENT/);
  assert.throws(() => readHallConfig(buildEnv({ HC_TOKEN_MAP: '' })), /HC_TOKEN_MAP/);
});

test('单展厅进程兼容：唯一展厅允许复用旧版 AGENT/INGRESS_* 变量', () => {
  const env = {
    PORT: '18031',
    HC_TOKEN_MAP: `${TOKEN_A}:${HALL_A}`,
    AGENT: 'legacy-agent',
    INGRESS_HOST: '127.0.0.1',
    INGRESS_PORT: '29876',
    INGRESS_TOKEN: 'legacy-token'
  };
  const config = readHallConfig(env);
  assert.equal(config.halls.get(HALL_A).agent, 'legacy-agent');
  assert.equal(config.halls.get(HALL_A).ingressPort, 29876);
  assert.equal(config.halls.get(HALL_A).ingressUrl, 'http://127.0.0.1:29876/agent/send');
});

test('两个展厅共用 AGENT 或共用回程目标时启动失败', () => {
  assert.throws(
    () => readHallConfig(buildEnv({ HC_HALL_EXHIBITION_B_AGENT: AGENT_A })),
    /AGENT is shared/
  );
  assert.throws(
    () => readHallConfig(buildEnv({ HC_HALL_EXHIBITION_B_INGRESS_PORT: '31001' })),
    /ingress target .*31001.* is shared/
  );
});

test('Token 映射规则与 IOC 一致：缺失、过短、未映射均不通过', () => {
  const tokenMap = parseTokenMap(`${TOKEN_A}:${HALL_A},${TOKEN_B}:${HALL_B}`);
  assert.equal(resolveExhibitionId(TOKEN_A, tokenMap), HALL_A);
  assert.equal(resolveExhibitionId(TOKEN_B, tokenMap), HALL_B);
  assert.equal(resolveExhibitionId(undefined, tokenMap), null);
  assert.equal(resolveExhibitionId('short', tokenMap), null);
  assert.equal(resolveExhibitionId('unknown-token-0123456789', tokenMap), null);
  assert.throws(() => parseTokenMap(`${TOKEN_A}:${HALL_A},${TOKEN_A}:${HALL_B}`), /duplicate token/);
  assert.throws(() => parseTokenMap('bad-entry'), /token:exhibitionId/);
});

test('展厅 ID 生成的变量前缀冲突时启动失败', () => {
  const env = buildEnv({
    HC_TOKEN_MAP: `${TOKEN_A}:exhibition-a,${TOKEN_B}:exhibition_a`,
    HC_HALL_EXHIBITION_A_AGENT: AGENT_A,
    HC_HALL_EXHIBITION_A_INGRESS_HOST: '127.0.0.1',
    HC_HALL_EXHIBITION_A_INGRESS_PORT: '31001',
    HC_HALL_EXHIBITION_A_INGRESS_TOKEN: 'out-token-a'
  });
  assert.throws(() => readHallConfig(env), /same environment prefix/);
});

test('示例 Token 会被拒绝，不能作为正式部署凭据', () => {
  assert.throws(() => parseTokenMap('example-token-a-0123456789abcdef:exhibition-a'), /placeholder token/);
  assert.throws(() => parseTokenMap('REPLACE_WITH_EXHIBITION_A_TOKEN:exhibition-a'), /placeholder token/);
  assert.throws(() => parseTokenMap('change-me-token-0123456789:exhibition-a'), /placeholder token/);
});

test('多展厅共用同一回程接收方时可被显式识别', () => {
  const config = readHallConfig(buildEnv({
    HC_HALL_EXHIBITION_A_TO: 'shared@example.net',
    HC_HALL_EXHIBITION_B_TO: 'shared@example.net'
  }));
  assert.deepEqual(findSharedRecipients(config.halls, 'default@example.net'), [
    { recipient: 'shared@example.net', exhibitionIds: [HALL_A, HALL_B] }
  ]);

  const distinct = readHallConfig(buildEnv({
    HC_HALL_EXHIBITION_A_TO: 'a@example.net',
    HC_HALL_EXHIBITION_B_TO: 'b@example.net'
  }));
  assert.deepEqual(findSharedRecipients(distinct.halls, 'default@example.net'), []);
});

test('多展厅共用同一接收方时启动日志给出告警', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const entries = [];
  const logger = {
    info() {},
    warn(message, details) { entries.push({ level: 'warn', message, details }); },
    error() {}
  };
  const running = await start({
    logger,
    loadConfigFn: () => buildConfig(port, mockA, mockB),
    createPollingRunnerFn: (options) => new PollingRunner({ ...options, script: PROBE_SCRIPT })
  });
  try {
    assert.ok(entries.some((entry) => entry.level === 'warn' && entry.message.includes('共用同一回程接收方')));
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

function mockIngress() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(text || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        requests,
        url: `http://127.0.0.1:${server.address().port}/agent/send`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function freePort() {
  const probe = http.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function buildConfig(port, mockA, mockB, overrides = {}) {
  const halls = new Map([
    [HALL_A, {
      hallId: HALL_A,
      agent: AGENT_A,
      ingressHost: '127.0.0.1',
      ingressPort: 31001,
      ingressToken: 'out-token-a',
      to: null,
      ingressUrl: mockA.url
    }],
    [HALL_B, {
      hallId: HALL_B,
      agent: AGENT_B,
      ingressHost: '127.0.0.1',
      ingressPort: 31002,
      ingressToken: 'out-token-b',
      to: null,
      ingressUrl: mockB.url
    }]
  ]);
  return {
    port,
    ingressTimeoutMs: 1000,
    pollingMaxDurationHours: 10,
    pollingMaxDurationMs: 36000000,
    tokenMap: new Map([[TOKEN_A, HALL_A], [TOKEN_B, HALL_B]]),
    halls,
    ...overrides
  };
}

const PROBE_SCRIPT = {
  initialDelayMs: 0,
  defaultMessageIntervalMs: 0,
  paragraphIntervalMs: 60000,
  paragraphs: [{ id: '01', messages: ['probe'] }]
};

async function startExecutor(config) {
  return start({
    loadConfigFn: () => config,
    createPollingRunnerFn: (options) => new PollingRunner({
      ...options,
      script: PROBE_SCRIPT
    })
  });
}

function request(port, method, path, payload, token) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = body === null ? {} : { 'Content-Type': 'application/json' };
    if (token !== undefined) headers['X-HC-Token'] = token;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('A/B Token 并发启动时各自使用自己的 AGENT、端口与回程鉴权 Token', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB));

  try {
    const started = await Promise.all([
      request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_A),
      request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_B)
    ]);
    assert.deepEqual(started.map((item) => item.statusCode), [200, 200]);

    await waitFor(() => mockA.requests.length >= 1 && mockB.requests.length >= 1);

    assert.equal(mockA.requests[0].body.agent, AGENT_A);
    assert.equal(mockA.requests[0].headers['x-auth-token'], 'out-token-a');
    assert.equal(mockB.requests[0].body.agent, AGENT_B);
    assert.equal(mockB.requests[0].headers['x-auth-token'], 'out-token-b');
    assert.ok(mockA.requests.every((item) => item.body.agent === AGENT_A));
    assert.ok(mockB.requests.every((item) => item.body.agent === AGENT_B));
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

test('停止一个展厅不会影响另一个展厅的轮询任务', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB));

  try {
    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_A);
    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_B);
    await waitFor(() => mockA.requests.length >= 1 && mockB.requests.length >= 1);

    const stopped = await request(port, 'POST', '/api/commands', [{ action: POLLING_CANCEL_ACTION, params: {} }], TOKEN_A);
    assert.deepEqual(stopped.body, { ok: true, message: 'polling stopped' });
    assert.equal(running.controllers.get(HALL_A).getStatus().state, 'stopped');
    assert.equal(running.controllers.get(HALL_B).getStatus().state, 'running');

    const countA = mockA.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(mockA.requests.length, countA);

    const stoppedB = await request(port, 'POST', '/api/commands', [{ action: POLLING_CANCEL_ACTION, params: {} }], TOKEN_B);
    assert.deepEqual(stoppedB.body, { ok: true, message: 'polling stopped' });
    assert.equal(running.controllers.get(HALL_B).getStatus().state, 'stopped');
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

test('缺失、无效与未映射 Token 均返回 401 且不产生回程请求', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB));
  const command = [{ action: POLLING_START_ACTION, params: {} }];

  try {
    assert.deepEqual(await request(port, 'POST', '/api/commands', command), {
      statusCode: 401, body: { ok: false, error: 'unauthorized' }
    });
    assert.deepEqual(await request(port, 'POST', '/api/commands', command, 'short'), {
      statusCode: 401, body: { ok: false, error: 'unauthorized' }
    });
    assert.deepEqual(await request(port, 'POST', '/api/commands', command, 'unknown-token-0123456789'), {
      statusCode: 401, body: { ok: false, error: 'unauthorized' }
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(mockA.requests.length, 0);
    assert.equal(mockB.requests.length, 0);
    assert.equal(running.controllers.get(HALL_A).getStatus().state, 'stopped');
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

test('请求体中的 exhibitionId/context 不能覆盖 Token 确定的展厅', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB));

  try {
    const response = await request(port, 'POST', '/api/commands', {
      exhibitionId: HALL_A,
      context: { exhibitionId: HALL_A, agent: 'spoofed-agent' },
      commands: [{ action: POLLING_START_ACTION, params: { exhibitionId: HALL_A } }]
    }, TOKEN_B);

    assert.equal(response.statusCode, 200);
    await waitFor(() => mockB.requests.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(mockA.requests.length, 0);
    assert.equal(mockB.requests[0].body.agent, AGENT_B);
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

test('未携带 Token 时 /health 与既有 404/405 行为保持不变', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB));

  try {
    assert.deepEqual(await request(port, 'GET', '/health'), { statusCode: 200, body: { status: 'ok' } });
    assert.deepEqual(await request(port, 'GET', '/api/commands'), {
      statusCode: 405, body: { ok: false, error: 'method not allowed' }
    });
    assert.deepEqual(await request(port, 'GET', '/api/unknown'), {
      statusCode: 404, body: { status: 'not_found' }
    });
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

test('一个展厅到期自动停止不影响其他展厅，且停止后可再次启动', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB, { pollingMaxDurationMs: 200 }));

  try {
    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_A);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_B);

    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(running.controllers.get(HALL_A).getStatus().state, 'stopped');
    assert.equal(running.controllers.get(HALL_B).getStatus().state, 'running');

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(running.controllers.get(HALL_B).getStatus().state, 'stopped');

    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_A);
    assert.equal(running.controllers.get(HALL_A).getStatus().state, 'running');
    assert.equal(running.controllers.get(HALL_B).getStatus().state, 'stopped');
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});

test('同一展厅重复启动不重置自己的超时计时，也不影响其他展厅', async () => {
  const mockA = await mockIngress();
  const mockB = await mockIngress();
  const port = await freePort();
  const running = await startExecutor(buildConfig(port, mockA, mockB, { pollingMaxDurationMs: 200 }));

  try {
    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_A);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const duplicate = await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_A);
    assert.deepEqual(duplicate.body, { ok: true, message: 'polling already running' });

    await request(port, 'POST', '/api/commands', [{ action: POLLING_START_ACTION, params: {} }], TOKEN_B);
    await new Promise((resolve) => setTimeout(resolve, 140));

    assert.equal(running.controllers.get(HALL_A).getStatus().state, 'stopped');
    assert.equal(running.controllers.get(HALL_B).getStatus().state, 'running');
  } finally {
    await running.shutdown('test');
    await mockA.close();
    await mockB.close();
  }
});
