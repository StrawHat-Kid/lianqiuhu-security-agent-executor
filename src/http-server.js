'use strict';

const http = require('node:http');

function createHealthServer() {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8'
      });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    response.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify({ status: 'not_found' }));
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
