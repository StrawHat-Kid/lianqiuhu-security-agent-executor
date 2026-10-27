const dotenv = require('dotenv');
const { parseTokenMap } = require('./hall-auth');

const MAX_TIMER_DELAY_MS = 2147483647;
const HALL_ENV_PREFIX = 'HC_HALL_';

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

function readRuntimeConfig(env) {
  const port = Number(env.PORT || 18031);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
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
  return { port, ingressTimeoutMs, pollingMaxDurationHours, pollingMaxDurationMs };
}

function hallEnvPrefix(hallId) {
  return HALL_ENV_PREFIX + hallId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function readHallEntry(env, hallId, allowLegacyFallback) {
  const prefix = hallEnvPrefix(hallId);
  const resolve = (suffix, legacyName) => {
    const scoped = env[`${prefix}_${suffix}`];
    if (nonEmpty(scoped)) return scoped.trim();
    if (allowLegacyFallback && legacyName && nonEmpty(env[legacyName])) return env[legacyName].trim();
    return '';
  };

  const agent = resolve('AGENT', 'AGENT');
  if (!agent) throw new Error(`missing required environment variable: ${prefix}_AGENT`);

  const ingressHost = resolve('INGRESS_HOST', 'INGRESS_HOST');
  if (!ingressHost) throw new Error(`missing required environment variable: ${prefix}_INGRESS_HOST`);
  if (/[\s/:]/.test(ingressHost)) {
    throw new Error(`${prefix}_INGRESS_HOST must be a hostname or IP address without protocol or path`);
  }

  const rawPort = resolve('INGRESS_PORT', 'INGRESS_PORT');
  if (!rawPort) throw new Error(`missing required environment variable: ${prefix}_INGRESS_PORT`);
  const ingressPort = Number(rawPort);
  if (!Number.isInteger(ingressPort) || ingressPort < 1 || ingressPort > 65535) {
    throw new Error(`${prefix}_INGRESS_PORT must be a valid TCP port`);
  }

  const ingressToken = resolve('INGRESS_TOKEN', 'INGRESS_TOKEN');
  if (!ingressToken) throw new Error(`missing required environment variable: ${prefix}_INGRESS_TOKEN`);

  const to = resolve('TO', null) || null;

  return Object.freeze({
    hallId,
    agent,
    ingressHost,
    ingressPort,
    ingressToken,
    to,
    ingressUrl: `http://${ingressHost}:${ingressPort}/agent/send`
  });
}

function assertNoHallConflicts(halls) {
  const seenPrefixes = new Map();
  for (const hallId of halls.keys()) {
    const prefix = hallEnvPrefix(hallId);
    if (seenPrefixes.has(prefix)) {
      throw new Error(`HC_TOKEN_MAP contains exhibition ids that share the same environment prefix ${prefix}: ${seenPrefixes.get(prefix)} and ${hallId}`);
    }
    seenPrefixes.set(prefix, hallId);
  }

  const seenAgents = new Map();
  const seenTargets = new Map();
  for (const hall of halls.values()) {
    if (seenAgents.has(hall.agent)) {
      throw new Error(`HC hall config conflict: AGENT is shared by ${seenAgents.get(hall.agent)} and ${hall.hallId}`);
    }
    seenAgents.set(hall.agent, hall.hallId);

    const target = `${hall.ingressHost}:${hall.ingressPort}`;
    if (seenTargets.has(target)) {
      throw new Error(`HC hall config conflict: ingress target ${target} is shared by ${seenTargets.get(target)} and ${hall.hallId}`);
    }
    seenTargets.set(target, hall.hallId);
  }
}

function readHallConfig(env = process.env) {
  const runtime = readRuntimeConfig(env);
  const tokenMap = parseTokenMap(env.HC_TOKEN_MAP);
  const hallIds = [...new Set(tokenMap.values())];
  const allowLegacyFallback = hallIds.length === 1;

  const halls = new Map();
  for (const hallId of hallIds) {
    halls.set(hallId, readHallEntry(env, hallId, allowLegacyFallback));
  }
  assertNoHallConflicts(halls);

  return { ...runtime, tokenMap, halls };
}

function findSharedRecipients(halls, defaultRecipient) {
  const groups = new Map();
  for (const hall of halls.values()) {
    const recipient = hall.to || defaultRecipient;
    if (!groups.has(recipient)) groups.set(recipient, []);
    groups.get(recipient).push(hall.hallId);
  }
  return [...groups.entries()]
    .filter(([, exhibitionIds]) => exhibitionIds.length > 1)
    .map(([recipient, exhibitionIds]) => ({ recipient, exhibitionIds }));
}

function loadConfig() {
  dotenv.config();
  return readHallConfig();
}

module.exports = { loadConfig, readHallConfig, hallEnvPrefix, readRuntimeConfig, findSharedRecipients };
