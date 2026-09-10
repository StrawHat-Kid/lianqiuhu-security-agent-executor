const dotenv = require('dotenv');

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

function readConfig(env = process.env) {
  for (const name of ['INGRESS_HOST', 'INGRESS_PORT', 'INGRESS_TOKEN']) {
    if (!nonEmpty(env[name])) throw new Error(`missing required environment variable: ${name}`);
  }
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
  return {
    port,
    ingressHost,
    ingressPort,
    ingressToken: env.INGRESS_TOKEN,
    ingressTimeoutMs,
    ingressUrl: `http://${ingressHost}:${ingressPort}/agent/send`
  };
}

function loadConfig() {
  dotenv.config();
  return readConfig();
}

module.exports = { loadConfig, readConfig };
