const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createRuisiClient } = require('./ruisi-client');
const { PollingRunner } = require('./polling-runner');
const script = require('./scripts/messages');
const AGENT = 'xslatdzp.SecOpsAgent';
const TO = 'xslatdzp.demo001@rscom-chat.rsagent.net';
async function main() {
  const logger = createLogger(); let config;
  try { config = loadConfig(); } catch (error) { logger.error('[专题轮询] 配置错误，执行器未启动', { error: error.message }); process.exitCode = 1; return; }
  const client = createRuisiClient({ ...config, authToken: config.ingressToken, timeoutMs: config.ingressTimeoutMs, logger });
  const runner = new PollingRunner({ agent: AGENT, to: TO, script, client, logger, subjectName: '安防智能体' });
  logger.info('[专题轮询] 执行器启动', { name: '安防智能体', agent: AGENT, to: TO, ingressHost: config.ingressHost, ingressPort: config.ingressPort });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { logger.info(`[专题轮询] 收到 ${signal}`); runner.stop(); });
  await runner.run(); logger.info('[专题轮询] 执行器退出', { name: '安防智能体' });
}
if (require.main === module) main().catch((error) => { createLogger().error('[专题轮询] 未捕获异常', { error: error.message }); process.exitCode = 1; });
module.exports = { AGENT, TO, main };
