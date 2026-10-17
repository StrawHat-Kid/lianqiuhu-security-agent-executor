const dotenv = require('dotenv');

const MAX_TIMER_DELAY_MS = 2147483647;

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

function readConfig(env = process.env) {
  for (const name of ['AGENT', 'INGRESS_HOST', 'INGRESS_PORT', 'INGRESS_TOKEN']) {
    if (!nonEmpty(env[name])) throw new Error(`missing required environment variable: ${name}`);
  }
  const agent = env.AGENT.trim();
  const port = Number(env.PORT || 18031);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  const ingressHost = env.INGRESS_HOST.trim();
  if (/[\\s/:]/.test(ingressHost)) {
    throw new Error('INGRESS_HOST must be a hostname or IP address without protocol or path');
  }
  const ingressPort = Number(env.INGRESS_PORT);
  if (!Number.isInteger(ingressPort) || ingressPort < 1 || ingressPort > 65535) {
    throw new Error('INGRESS_PORT must be a valid TCP port');
  }
  const ingressTimeoutMs = Number(env.INGRESS_TIMEOUT_MS || 5000);
  if (!Number.isInteger(ingressTimeoutMs) || ingressTimeoutMs < 1) {
    throw new Error('INGRESS_TIMEOUT_MS must be a positive integer');
  }
  const pollingMaxDurationHours = Number(env.POLLING_MAX_DURATION_HOURS || 10);
  if (!Number.isFinite(pollingMaxDurationHours) || pollingMaxDurationHours <= 0) {
    throw new Error('POLLING_MAX_DURATION_HOURS must be a positive finite number');
  }
  const pollingMaxDurationMs = Math.round(pollingMaxDurationHours * 60 * 60 * 1000);
  if (!Number.isFinite(pollingMaxDurationMs) || pollingMaxDurationMs <= 0 || pollingMaxDurationMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`POLLING_MAX_DURATION_HOURS is out of supported range: converted duration must be between 1 and ${MAX_TIMER_DELAY_MS} ms (about 596.52 hours)`);
  }
  return {
    agent,
    port,
    ingressHost,
    ingressPort,
    ingressToken: env.INGRESS_TOKEN,
    ingressTimeoutMs,
    pollingMaxDurationHours,
    pollingMaxDurationMs,
    ingressUrl: `http://${ingressHost}:${ingressPort}/agent/send`
  };
}

function loadConfig() {
  dotenv.config();
  return readConfig();
}

module.exports = { loadConfig, readConfig };
