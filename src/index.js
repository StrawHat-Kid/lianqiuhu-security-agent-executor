const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createRuisiClient } = require('./ruisi-client');
const { PollingRunner } = require('./polling-runner');
const { createHealthServer, listenHttpServer, closeHttpServer } = require('./http-server');
const { createPollingController } = require('./polling-controller');
const script = require('./scripts/messages');

const TO = 'xslatdzp.demo001@rscom-chat.rsagent.net';
const SUBJECT_NAME = '安防智能体';
const POLLING_START_ACTION = '启动园区AI安防智能体';
const POLLING_CANCEL_ACTION = '取消园区AI安防智能体';

async function start({
  logger = createLogger(),
  loadConfigFn = loadConfig,
  createHealthServerFn = createHealthServer,
  listenHttpServerFn = listenHttpServer,
  closeHttpServerFn = closeHttpServer,
  createRuisiClientFn = createRuisiClient,
  createPollingRunnerFn = (options) => new PollingRunner(options),
  createPollingControllerFn = createPollingController,
  scriptDefinition = script
} = {}) {
  const config = loadConfigFn();

  logger.info('[专题轮询] 执行器启动中', {
    name: SUBJECT_NAME,
    agent: config.agent,
    to: TO,
    port: config.port,
    ingressHost: config.ingressHost,
    ingressPort: config.ingressPort
  });

  const client = createRuisiClientFn({
    ...config,
    authToken: config.ingressToken,
    timeoutMs: config.ingressTimeoutMs,
    logger
  });
  const controller = createPollingControllerFn({
    logger,
    subjectName: SUBJECT_NAME,
    maxDurationMs: config.pollingMaxDurationMs,
    createRunner: () => createPollingRunnerFn({
      agent: config.agent,
      to: TO,
      script: scriptDefinition,
      client,
      logger,
      subjectName: SUBJECT_NAME
    })
  });
  const server = createHealthServerFn({
    controller,
    pollingActions: { start: POLLING_START_ACTION, cancel: POLLING_CANCEL_ACTION },
    logger
  });

  try {
    // 与 IOC 执行器一致：未显式指定 host，使用 Node.js 默认监听行为。
    await listenHttpServerFn(server, config.port);
  } catch (error) {
    logger.error('[专题轮询] HTTP 服务监听失败，回程轮询未启动', {
      port: config.port,
      error: error.message
    });
    throw error;
  }

  logger.info('[专题轮询] HTTP 服务监听成功', { port: config.port });
  logger.info('[专题轮询] 回程轮询默认未开启，等待指令调用', {
    name: SUBJECT_NAME,
    commandPath: '/api/commands',
    startAction: POLLING_START_ACTION,
    cancelAction: POLLING_CANCEL_ACTION,
    pollingMaxDurationHours: config.pollingMaxDurationHours
  });

  let shutdownPromise;

  const shutdown = (reason) => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        logger.info('[专题轮询] 执行器停止中', { name: SUBJECT_NAME, reason });

        try {
          await controller.shutdown(reason);
        } finally {
          await closeHttpServerFn(server);
          logger.info('[专题轮询] HTTP 服务已关闭', { port: config.port });
        }
      })();
    }

    return shutdownPromise;
  };

  return { config, server, controller, shutdown, logger };
}

function installShutdownHandlers({ running, logger, processRef = process }) {
  let requestedShutdown;
  let resolveShutdownRequested;
  const shutdownRequested = new Promise((resolve) => {
    resolveShutdownRequested = resolve;
  });

  const shutdown = (reason, logSignal = true) => {
    if (!requestedShutdown) {
      if (logSignal) {
        logger.info('[专题轮询] 收到 ' + reason);
      }

      requestedShutdown = running.shutdown(reason);
      requestedShutdown.catch((error) => {
        logger.error('[专题轮询] 退出失败', { error: error.message });
        processRef.exitCode = 1;
      });
      requestedShutdown.then(
        () => resolveShutdownRequested(),
        () => resolveShutdownRequested()
      );
    }

    return requestedShutdown;
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    processRef.once(signal, () => {
      shutdown(signal);
    });
  }

  return { shutdown, whenShutdown: shutdownRequested };
}

async function main() {
  const logger = createLogger();
  let running;

  try {
    running = await start({ logger });
  } catch (error) {
    logger.error('[专题轮询] 执行器启动失败', { error: error.message });
    process.exitCode = 1;
    return;
  }

  const shutdownHandlers = installShutdownHandlers({ running, logger });
  await shutdownHandlers.whenShutdown;
  logger.info('[专题轮询] 执行器退出', { name: SUBJECT_NAME });
}

if (require.main === module) {
  main().catch((error) => {
    createLogger().error('[专题轮询] 未捕获异常', { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = {
  TO,
  SUBJECT_NAME,
  POLLING_START_ACTION,
  POLLING_CANCEL_ACTION,
  start,
  installShutdownHandlers,
  main
};
