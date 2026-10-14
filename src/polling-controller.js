'use strict';

function createPollingController({ createRunner, logger, subjectName } = {}) {
  if (typeof createRunner !== 'function') {
    throw new Error('createRunner is required');
  }

  const log = logger || { info() {}, warn() {}, error() {} };
  const name = subjectName || 'polling';

  let state = 'idle';
  let runner = null;
  let runSettled = null;
  let runCompleted = false;
  let startedAt = null;
  let transition = Promise.resolve();

  function enqueue(task) {
    const result = transition.then(task, task);
    transition = result.then(() => undefined, () => undefined);
    return result;
  }

  function clearRunner() {
    runner = null;
    runSettled = null;
    runCompleted = false;
    startedAt = null;
  }

  function publicState() {
    if (state === 'stopping') return 'stopping';
    return state === 'idle' ? 'stopped' : 'running';
  }

  function handleUnexpectedExit() {
    if (state === 'running') {
      log.warn('[专题轮询控制] Polling Runner 已结束，进入空闲状态', { name });
      clearRunner();
      state = 'idle';
    }
  }

  function startNow(reason) {
    if (state === 'running' || state === 'starting') {
      if (!runCompleted) {
        return { state: 'running', alreadyRunning: true };
      }
      clearRunner();
      state = 'idle';
    }

    state = 'starting';
    runner = createRunner();
    startedAt = new Date().toISOString();
    const activeRunner = runner;
    const activeRun = Promise.resolve().then(() => activeRunner.run());
    runSettled = activeRun.then(
      () => { runCompleted = true; },
      (error) => {
        runCompleted = true;
        log.error('[专题轮询控制] Polling Runner 异常退出', {
          name,
          error: error && error.message ? error.message : String(error)
        });
      }
    );
    runSettled.then(handleUnexpectedExit);
    state = 'running';
    log.info('[专题轮询控制] 回程轮询已开启', { name, reason, startedAt });
    return { state: 'running', alreadyRunning: false };
  }

  async function stopNow({ abortInFlight = false, reason = 'control' } = {}) {
    if (state !== 'running') {
      return { state: 'stopped', alreadyStopped: true };
    }

    state = 'stopping';
    const activeRunner = runner;
    const settled = runSettled || Promise.resolve();
    log.info('[专题轮询控制] 正在停止回程轮询', { name, reason, abortInFlight });
    activeRunner.stop({ abortInFlight });
    await settled;
    clearRunner();
    state = 'idle';
    log.info('[专题轮询控制] 回程轮询已停止', { name, reason, abortInFlight });
    return { state: 'stopped', alreadyStopped: false };
  }

  return {
    start: (reason) => enqueue(() => startNow(reason || 'control')),
    stop: (options) => enqueue(() => stopNow(options || {})),
    shutdown: (reason) => enqueue(() => stopNow({ abortInFlight: true, reason: reason || 'shutdown' })),
    getStatus: () => ({
      state: publicState(),
      name,
      startedAt: state === 'running' ? startedAt : null
    })
  };
}

module.exports = { createPollingController };
