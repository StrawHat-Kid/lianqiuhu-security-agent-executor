function createRuisiClient({ ingressUrl, authToken, timeoutMs = 5000, logger, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('INGRESS_TIMEOUT_MS must be a positive integer');
  const log = logger || { info() {}, error() {} };
  async function sendMessage({ agent, to, body, groupchat = false, signal } = {}) {
    if (!agent || !to || !body || groupchat !== false) throw new Error('agent, to, body and groupchat=false are required');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const payload = { agent, to, body, groupchat: false };
    const logDetails = { ingressUrl, agent, to, groupchat: false, timeoutMs };
    log.info('[专题轮询→RUISI回程] 准备发送消息', logDetails);
    try {
      const response = await fetchImpl(ingressUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken }, body: JSON.stringify(payload), signal: controller.signal });
      if (response.ok) { log.info('[专题轮询→RUISI回程] 发送成功', { ...logDetails, status: response.status }); return { ok: true, status: response.status }; }
      log.error('[专题轮询→RUISI回程] 发送失败', { ...logDetails, status: response.status });
      return { ok: false, status: response.status, error: `RUISI ingress failed with status ${response.status}` };
    } catch (error) {
      const cancelled = signal?.aborted;
      const timedOut = error?.name === 'AbortError' && !cancelled;
      if (!cancelled) log.error(timedOut ? '[专题轮询→RUISI回程] 请求超时' : '[专题轮询→RUISI回程] 网络异常', { ...logDetails, error: error?.message || 'unknown error' });
      return { ok: false, status: null, cancelled, error: cancelled ? 'cancelled' : (timedOut ? `timeout after ${timeoutMs}ms` : 'network error') };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abortFromCaller); }
  }
  return { sendMessage };
}
module.exports = { createRuisiClient };
