function positiveInteger(value, label) { if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); }
class PollingRunner {
  constructor({ agent, to, script, client, logger, sleep } = {}) {
    if (!agent || !to || !client || typeof client.sendMessage !== 'function') throw new Error('agent, to and client are required');
    if (!script || !Array.isArray(script.messages) || script.messages.length === 0) throw new Error('script.messages must not be empty');
    positiveInteger(script.initialDelayMs, 'initialDelayMs'); positiveInteger(script.defaultMessageIntervalMs, 'defaultMessageIntervalMs'); positiveInteger(script.roundIntervalMs, 'roundIntervalMs');
    for (const message of script.messages) { if (!message || typeof message.body !== 'string' || !message.body.trim()) throw new Error('each script message needs a body'); if (message.delayAfterMs !== undefined) positiveInteger(message.delayAfterMs, 'delayAfterMs'); }
    this.agent = agent; this.to = to; this.script = script; this.client = client; this.logger = logger || { info() {}, error() {} }; this.sleep = sleep || ((ms) => this.defaultSleep(ms)); this.stopped = false; this.pendingWake = null; this.activeController = null;
  }
  defaultSleep(ms) { return new Promise((resolve) => { const timer = setTimeout(() => { this.pendingWake = null; resolve(true); }, ms); this.pendingWake = () => { clearTimeout(timer); this.pendingWake = null; resolve(false); }; }); }
  async wait(ms) { const result = await this.sleep(ms); return result !== false && !this.stopped; }
  stop() { this.stopped = true; this.activeController?.abort(); this.pendingWake?.(); }
  async run({ maxRounds = Infinity } = {}) {
    this.logger.info('[专题轮询] 等待首次发送', { initialDelayMs: this.script.initialDelayMs });
    if (!(await this.wait(this.script.initialDelayMs))) return;
    for (let round = 1; round <= maxRounds && !this.stopped; round += 1) {
      this.logger.info('[专题轮询] 本轮开始', { round });
      for (let index = 0; index < this.script.messages.length && !this.stopped; index += 1) {
        const message = this.script.messages[index]; this.logger.info('[专题轮询] 准备发送第 N 条', { round, messageIndex: index + 1, messageCount: this.script.messages.length });
        this.activeController = new AbortController(); const result = await this.client.sendMessage({ agent: this.agent, to: this.to, body: message.body, groupchat: false, signal: this.activeController.signal }); this.activeController = null;
        if (this.stopped) break;
        if (!result.ok) this.logger.error('[专题轮询] 本条发送失败，继续后续轮询', { round, messageIndex: index + 1, status: result.status, error: result.error });
        if (index < this.script.messages.length - 1) { const delayMs = message.delayAfterMs === undefined ? this.script.defaultMessageIntervalMs : message.delayAfterMs; if (!(await this.wait(delayMs))) return; }
      }
      if (this.stopped) return; this.logger.info('[专题轮询] 本轮完成', { round });
      if (round < maxRounds) { this.logger.info('[专题轮询] 等待下一轮', { roundIntervalMs: this.script.roundIntervalMs }); if (!(await this.wait(this.script.roundIntervalMs))) return; }
    }
  }
}
module.exports = { PollingRunner };
