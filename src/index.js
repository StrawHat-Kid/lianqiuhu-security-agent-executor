const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createRuisiClient } = require('./ruisi-client');
const { PollingRunner } = require('./polling-runner');
const { createHealthServer, listenHttpServer, closeHttpServer } = require('./http-server');
const script = require('./scripts/messages');

const TO = 'xslatdzp.demo001@rscom-chat.rsagent.net';
const SUBJECT_NAME = '安防智能体';

async function start({
  logger = createLogger(),
  loadConfigFn = loadConfig,
  createHealthServerFn = createHealthServer,
  listenHttpServerFn = listenHttpServer,
  closeHttpServerFn = closeHttpServer,
  createRuisiClientFn = createRuisiClient,
  createPollingRunnerFn = (options) => new PollingRunner(options),
  scriptDefinition = script
} = {}) {
  const config = loadConfigFn();
  const server = createHealthServerFn();

  logger.info('[专题轮询] 执行器启动中', {
    name: SUBJECT_NAME,
    agent: config.agent,
    to: TO,
    port: config.port,
    ingressHost: config.ingressHost,
    ingressPort: config.ingressPort
  });

  try {
    // 与 IOC 执行器一致：未显式指定 host，使用 Node.js 默认监听行为。
    await listenHttpServerFn(server, config.port);
  } catch (error) {
    logger.error('[专题轮询] HTTP 服务监听失败，Polling Runner 未启动', {
      port: config.port,
      error: error.message
    });
    throw error;
  }

  logger.info('[专题轮询] HTTP 服务监听成功', { port: config.port });

  const client = createRuisiClientFn({
    ...config,
    authToken: config.ingressToken,
    timeoutMs: config.ingressTimeoutMs,
    logger
  });
  const runner = createPollingRunnerFn({
    agent: config.agent,
    to: TO,
    script: scriptDefinition,
    client,
    logger,
    subjectName: SUBJECT_NAME
  });
  const runPromise = runner.run();
  let shutdownPromise;

  const shutdown = (reason) => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        logger.info('[专题轮询] 执行器停止中', { name: SUBJECT_NAME, reason });
        runner.stop();

        try {
          await runPromise;
        } finally {
          await closeHttpServerFn(server);
          logger.info('[专题轮询] HTTP 服务已关闭', { port: config.port });
        }
      })();
    }

    return shutdownPromise;
  };

  return { config, server, runner, runPromise, shutdown, logger };
}

function installShutdownHandlers({ running, logger, processRef = process }) {
  let requestedShutdown;

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
    }

    return requestedShutdown;
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    processRef.once(signal, () => {
      shutdown(signal);
    });
  }

  return { shutdown };
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
  let runError;

  try {
    await running.runPromise;
  } catch (error) {
    runError = error;
    logger.error('[专题轮询] Polling Runner 异常退出', { error: error.message });
    process.exitCode = 1;
  }

  try {
    await shutdownHandlers.shutdown('Polling Runner 已结束', false);
  } catch (error) {
    if (!runError) {
      logger.error('[专题轮询] 执行器退出失败', { error: error.message });
      process.exitCode = 1;
    }
  }

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
  start,
  installShutdownHandlers,
  main
};
