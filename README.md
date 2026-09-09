# 练秋湖 HC 安防智能体轮询执行器

此进程按正式固定剧本，将 安防 专题文字逐条发送到 RUISI-OSCA 回程接口；不接收 IOC 指令、不使用 MQTT，也不生成园区数据。

固定映射：`安防智能体` → `xslatdzp.SecOpsAgent`，接收方为 `xslatdzp.demo001@rscom-chat.rsagent.net`。

## 使用

```bash
npm install
# 本地已有 .env；部署时从 .env.example 创建 .env 并填入产品提供的 token
npm test
npm start
```

`.env` 已被 Git 忽略，不能提交。可选 `INGRESS_TIMEOUT_MS` 默认值为 `5000` 毫秒。

## 正式固定轮询

正式剧本位于 `src/scripts/messages.js`，共 12 个段落、28 条消息。启动后立即发送段落01第1条；同段相邻消息间隔 40 秒；每段最后一条后仅等待 12 分钟进入下一段；段落12后同样等待 12 分钟并回到段落01。没有额外的 round interval 或段间 40 秒。

回程请求为 `POST http://${INGRESS_HOST}:${INGRESS_PORT}/agent/send`，携带 JSON 与 `X-Auth-Token`。HTTP 任意 2xx 均视为成功；单条失败会记录日志，后续消息和轮询继续执行。
