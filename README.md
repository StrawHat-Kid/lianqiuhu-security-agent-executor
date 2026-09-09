# 练秋湖 HC 安防智能体轮询执行器

此进程只按固定顺序将安防专题的文字剧本发送到 RUISI-OSCA 回程接口；不接收 IOC 指令、不使用 MQTT，也不生成园区数据。

固定映射：`安防智能体` → `xslatdzp.SecOpsAgent`，接收方为 `xslatdzp.demo001@rscom-chat.rsagent.net`。

## 使用

```bash
npm install
# 本地已有 .env；部署时从 .env.example 创建 .env 并填入产品提供的 token
npm test
npm start
```

`.env` 仅供本地或部署环境使用，已被 Git 忽略，不能提交。`INGRESS_TIMEOUT_MS` 可选，默认 `5000` 毫秒。

## 轮询配置

联调剧本与临时节奏都在 `src/scripts/messages.js`：`initialDelayMs`、`defaultMessageIntervalMs`、单条 `delayAfterMs` 和 `roundIntervalMs`。这些是本地联调默认值，不是正式 HC 展示节奏；替换正式文案或时间只需修改该配置文件。

回程请求为 `POST http://${INGRESS_HOST}:${INGRESS_PORT}/agent/send`，携带 JSON 和 `X-Auth-Token`。HTTP 任意 2xx 均视为成功；单条失败会记录日志，后续消息和轮询继续执行。
