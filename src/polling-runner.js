function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

class PollingRunner {
  constructor({ agent, to, script, client, logger, sleep, subjectName } = {}) {
    if (!agent || !to || !client || typeof client.sendMessage !== 'function') {
      throw new Error('agent, to and client are required');
    }
    if (!script || !Array.isArray(script.paragraphs) || script.paragraphs.length === 0) {
      throw new Error('script.paragraphs must not be empty');
    }
    nonNegativeInteger(script.initialDelayMs, 'initialDelayMs');
    nonNegativeInteger(script.defaultMessageIntervalMs, 'defaultMessageIntervalMs');
    nonNegativeInteger(script.paragraphIntervalMs, 'paragraphIntervalMs');
    for (const paragraph of script.paragraphs) {
      if (!paragraph || typeof paragraph.id !== 'string' || !paragraph.id.trim() || !Array.isArray(paragraph.messages) || paragraph.messages.length === 0) {
        throw new Error('each paragraph needs an id and non-empty messages');
      }
      for (const body of paragraph.messages) {
        if (typeof body !== 'string' || !body.trim()) throw new Error('each paragraph message needs a body');
      }
    }
    this.agent = agent;
    this.to = to;
    this.script = script;
    this.client = client;
    this.logger = logger || { info() {}, error() {} };
    this.sleep = sleep || ((ms) => this.defaultSleep(ms));
    this.subjectName = subjectName || agent;
    this.stopped = false;
    this.pendingWake = null;
    this.activeController = null;
  }

  defaultSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWake = null;
        resolve(true);
      }, ms);
      this.pendingWake = () => {
        clearTimeout(timer);
        this.pendingWake = null;
        resolve(false);
      };
    });
  }

  async wait(ms) {
    const result = await this.sleep(ms);
    return result !== false && !this.stopped;
  }

  stop() {
    this.stopped = true;
    this.activeController?.abort();
    this.pendingWake?.();
  }

  async run({ maxRounds = Infinity } = {}) {
    if (this.script.initialDelayMs > 0) {
      this.logger.info('[专题轮询] 等待首次发送', { name: this.subjectName, initialDelayMs: this.script.initialDelayMs });
      if (!(await this.wait(this.script.initialDelayMs))) return;
    } else {
      this.logger.info('[专题轮询] 首段立即发送', { name: this.subjectName });
    }

    for (let round = 1; round <= maxRounds && !this.stopped; round += 1) {
      this.logger.info('[专题轮询] 本轮开始', { name: this.subjectName, round });
      for (let paragraphIndex = 0; paragraphIndex < this.script.paragraphs.length && !this.stopped; paragraphIndex += 1) {
        const paragraph = this.script.paragraphs[paragraphIndex];
        const nextParagraph = this.script.paragraphs[(paragraphIndex + 1) % this.script.paragraphs.length];
        this.logger.info('[专题轮询] 进入段落', {
          name: this.subjectName, round, paragraphId: paragraph.id, messageCount: paragraph.messages.length
        });

        for (let messageIndex = 0; messageIndex < paragraph.messages.length && !this.stopped; messageIndex += 1) {
          this.logger.info('[专题轮询] 准备发送消息', {
            name: this.subjectName, round, paragraphId: paragraph.id,
            messageIndex: messageIndex + 1, messageCount: paragraph.messages.length
          });
          this.activeController = new AbortController();
          const result = await this.client.sendMessage({
            agent: this.agent,
            to: this.to,
            body: paragraph.messages[messageIndex],
            groupchat: false,
            signal: this.activeController.signal,
            paragraphId: paragraph.id,
            messageIndex: messageIndex + 1,
            messageCount: paragraph.messages.length
          });
          this.activeController = null;
          if (this.stopped) return;
          if (!result.ok) {
            this.logger.error('[专题轮询] 本条发送失败，继续后续轮询', {
              name: this.subjectName, round, paragraphId: paragraph.id,
              messageIndex: messageIndex + 1, status: result.status, error: result.error
            });
          }
          if (messageIndex < paragraph.messages.length - 1 && !(await this.wait(this.script.defaultMessageIntervalMs))) return;
        }

        this.logger.info('[专题轮询] 段落完成，等待进入下一段', {
          name: this.subjectName, round, paragraphId: paragraph.id,
          nextParagraphId: nextParagraph.id, paragraphIntervalMs: this.script.paragraphIntervalMs
        });
        if (!(await this.wait(this.script.paragraphIntervalMs))) return;
      }
      this.logger.info('[专题轮询] 本轮完成', { name: this.subjectName, round });
    }
  }
}

module.exports = { PollingRunner };
