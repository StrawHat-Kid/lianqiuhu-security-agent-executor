# 练秋湖 HC 安防智能体轮询执行器

此进程按正式固定剧本，将 安防 专题文字逐条发送到 RUISI-OSCA 回程接口；不接收 IOC 指令、不使用 MQTT，也不生成园区数据。

固定映射：`安防智能体` 的 AGENT 由 `.env` 配置，接收方为 `xslatdzp.demo001@rscom-chat.rsagent.net`。

## 使用

```bash
npm install
# 本地已有 .env；部署时从 .env.example 创建 .env 并填入产品提供的 token
npm test
npm start
```

`.env` 已被 Git 忽略，不能提交。默认启动端口为 `18031`，`PORT` 与 `AGENT` 均可通过 `.env` 配置；可选 `INGRESS_TIMEOUT_MS` 默认值为 `5000` 毫秒。

```bash
PORT=18031
AGENT=rs-demorg-secops
```

## 回程轮询指令接口

执行器启动后只监听 HTTP 端口，**默认不开启回程轮询**；由外部通过 `POST /api/commands` 发送指令开启或关闭。该路径、方法与请求体结构与 `lianqiuhu-ioc-executor` 一致；本接口**未实现应用层鉴权**（不校验任何 Token）。

请求体为 JSON 数组，元素为 `{ "action": "...", "params": {} }`：

```bash
curl -X POST http://127.0.0.1:18031/api/commands \
  -H "Content-Type: application/json" \
  -d '[{"action":"启动园区AI安防智能体","params":{}}]'
# {"ok":true,"message":"polling started"}

curl -X POST http://127.0.0.1:18031/api/commands \
  -H "Content-Type: application/json" \
  -d '[{"action":"取消园区AI安防智能体","params":{}}]'
# {"ok":true,"message":"polling stopped"}
```

| 指令（action） | 行为 |
| --- | --- |
| `启动园区AI安防智能体` | 开启回程轮询；重复调用不会创建多个轮询任务（返回 `polling already running`） |
| `取消园区AI安防智能体` | 停止回程轮询；等待在途请求完成后停止（最长 `INGRESS_TIMEOUT_MS`）；重复调用返回 `polling already stopped` |

- 指令名称为《HC功能指令设计总表》中的正式名称（已确认）；睿司侧的指令注册与真实调用联调尚未完成，部署前需完成对应配置与联调。
- 也接受 `{"commands":[...]}` 信封格式（与指令执行器一致）；`params` 可省略或为空对象，内容会被忽略。
- 未知 action、非法 JSON、空数组、仅含 action 的单个对象、`params` 非对象等返回 `400 {"ok":false,"error":"..."}`；`/api/commands` 使用非 POST 方法返回 `405`；其他路径返回 `404 {"status":"not_found"}`。
- 停止后再次发送启动指令会创建新的轮询任务，并从段落 01 第 1 条重新开始；`SIGINT`/`SIGTERM` 仍会中止在途请求并退出进程。
- 原 `/api/polling/start`、`/api/polling/stop`、`/api/polling/status` 路由已移除，不再对外提供。
- 健康检查：`GET /health` 返回 HTTP `200` 与 `{"status":"ok"}`，停止轮询后仍然可用。

**安全说明（本轮）**：指令接口未实现应用层鉴权（不校验任何 Token）。部署时必须通过内网访问限制、防火墙、安全组或其他网络访问控制手段，限制可访问执行器端口的来源，以降低未授权调用风险。

## 正式固定轮询

正式剧本位于 `src/scripts/messages.js`，共 12 个段落、28 条消息。开启轮询后立即发送段落01第1条；同段相邻消息间隔 40 秒；每段最后一条后仅等待 12 分钟进入下一段；段落12后同样等待 12 分钟并回到段落01。没有额外的 round interval 或段间 40 秒。

回程请求为 `POST http://${INGRESS_HOST}:${INGRESS_PORT}/agent/send`，携带 JSON 与 `X-Auth-Token`。HTTP 任意 2xx 均视为成功；单条失败会记录日志，后续消息和轮询继续执行。收到停止请求后等待在途请求结束，不再发送后续消息。
