// 本地联调 / 临时测试默认值；不是正式 HC 展示文案或节奏。
module.exports = Object.freeze({ initialDelayMs: 1000, defaultMessageIntervalMs: 3000, roundIntervalMs: 10000, messages: Object.freeze([
  Object.freeze({ body: '【联调测试】安防智能体轮询消息 1', delayAfterMs: 4000 }),
  Object.freeze({ body: '【联调测试】安防智能体轮询消息 2' }),
  Object.freeze({ body: '【联调测试】安防智能体轮询消息 3' })
]) });
