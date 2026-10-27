'use strict';

const http = require('node:http');
const { TOKEN_HEADER, resolveExhibitionId, readTokenHeader } = require('./hall-auth');

const BODY_LIMIT_BYTES = 100 * 1024;

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error) => {
      reject(error);
    });
  });
}

function normalizeCommands(body) {
  if (Array.isArray(body)) return body;
  if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, 'commands')) {
    if (!Array.isArray(body.commands)) throw new Error('envelope commands must be an array');
    return body.commands;
  }
  throw new Error('request body must be an array or context envelope');
}

function validateCommands(commands) {
  if (commands.length === 0) return 'request body must not be empty';

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!isPlainObject(command)) return `command at index ${index} must be a plain object`;
    if (typeof command.action !== 'string' || command.action.trim() === '') {
      return `command at index ${index} must include a non-empty string action`;
    }
    if (Object.prototype.hasOwnProperty.call(command, 'params') && !isPlainObject(command.params)) {
      return `command at index ${index} params must be a plain object`;
    }
  }
  return null;
}

function classifyCommands(commands, pollingActions) {
  return commands.map((command) => {
    if (command.action === pollingActions.start) return 'start';
    if (command.action === pollingActions.cancel) return 'cancel';
    return null;
  });
}

async function executeCommands(commands, controller, pollingActions) {
  const kinds = classifyCommands(commands, pollingActions);
  const unknownIndex = kinds.indexOf(null);
  if (unknownIndex !== -1) {
    return { ok: false, status: 400, error: `command at index ${unknownIndex} action is not registered` };
  }

  let message = null;
  for (const kind of kinds) {
    if (kind === 'start') {
      const result = await controller.start('commands');
      message = result.alreadyRunning ? 'polling already running' : 'polling started';
    } else {
      const result = await controller.stop({ abortInFlight: false, reason: 'commands' });
      message = result.alreadyStopped ? 'polling already stopped' : 'polling stopped';
    }
  }
  return { ok: true, status: 200, message };
}

async function handleCommandsRequest(request, response, { controller, exhibitionId, pollingActions, log }) {
  let text;
  try {
    text = await readRequestBody(request);
  } catch (error) {
    const message = error && error.message ? error.message : 'request body read failed';
    const status = message === 'request body too large' ? 413 : 400;
    log.error('[专题轮询控制] 读取请求体失败', { exhibitionId, error: message });
    sendJson(response, status, { ok: false, error: message });
    return;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid JSON request body' });
    return;
  }

  let commands;
  try {
    commands = normalizeCommands(body);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
    return;
  }

  const validationError = validateCommands(commands);
  if (validationError) {
    sendJson(response, 400, { ok: false, error: validationError });
    return;
  }

  if (!controller) {
    sendJson(response, 503, { ok: false, error: 'polling controller unavailable' });
    return;
  }

  if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, 'exhibitionId')) {
    log.warn('[专题轮询控制] 忽略请求体中的 exhibitionId，使用服务端 Token 映射', {
      exhibitionId,
      bodyExhibitionId: String(body.exhibitionId)
    });
  }

  try {
    const result = await executeCommands(commands, controller, pollingActions);
    if (result.ok) {
      sendJson(response, result.status, { ok: true, message: result.message });
    } else {
      sendJson(response, result.status, { ok: false, error: result.error });
    }
  } catch (error) {
    log.error('[专题轮询控制] 指令处理失败', {
      exhibitionId,
      error: error && error.message ? error.message : String(error)
    });
    sendJson(response, 500, { ok: false, error: 'polling command failed' });
  }
}

function createHealthServer({ controllers, tokenMap, pollingActions, logger } = {}) {
  const log = logger || { info() {}, warn() {}, error() {} };

  return http.createServer((request, response) => {
    const path = String(request.url || '').split('?')[0];

    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (path === '/api/commands') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' }, { Allow: 'POST' });
        return;
      }

      const presentedToken = readTokenHeader(request);
      const exhibitionId = resolveExhibitionId(presentedToken, tokenMap);
      if (!exhibitionId) {
        const reason = typeof presentedToken === 'string' && presentedToken.trim() !== '' ? 'invalid_token' : 'missing_token';
        log.warn('[专题轮询控制] 请求被拒绝，未改变任何轮询状态', {
          method: request.method,
          path,
          remoteAddress: request.socket?.remoteAddress,
          headerName: TOKEN_HEADER,
          reason
        });
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      log.info('[专题轮询控制] 收到指令请求', {
        method: request.method,
        path,
        exhibitionId,
        remoteAddress: request.socket?.remoteAddress
      });
      handleCommandsRequest(request, response, {
        controller: controllers ? controllers.get(exhibitionId) : null,
        exhibitionId,
        pollingActions,
        log
      }).catch((error) => {
        log.error('[专题轮询控制] 指令处理异常', {
          exhibitionId,
          error: error && error.message ? error.message : String(error)
        });
        if (!response.writableEnded) {
          sendJson(response, 500, { ok: false, error: 'polling command failed' });
        }
      });
      return;
    }

    sendJson(response, 404, { status: 'not_found' });
  });
}

function listenHttpServer(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onListening = () => {
      cleanup();
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);

    try {
      // 与 IOC 执行器一致：不显式指定 host，使用 Node.js 默认监听行为。
      server.listen(port);
    } catch (error) {
      onError(error);
    }
  });
}

function closeHttpServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  createHealthServer,
  listenHttpServer,
  closeHttpServer
};
