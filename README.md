# 练秋湖 HC 安防智能体轮询执行器

此进程按正式固定剧本，将 安防 专题文字逐条发送到 RUISI-OSCA 回程接口；不接收 IOC 指令、不使用 MQTT，也不生成园区数据。

固定映射：`安防智能体` 在每个展厅各有一套 `AGENT` 与回程入口配置，由 `.env` 按展厅配置；回程接收方默认仍为 `xslatdzp.demo001@rscom-chat.rsagent.net`（可用 `HC_HALL_<展厅>_TO` 覆盖）。

## 多展厅回程隔离

- 所有 `POST /api/commands` 请求必须携带 `X-HC-Token`；服务端用 `HC_TOKEN_MAP` 将该 Token 精确映射为展厅 ID。
- 缺失、无效或未映射的 Token 一律返回 `401 {"ok":false,"error":"unauthorized"}`，不会回退到任何展厅的配置。
- 展厅身份只由 Token 决定；请求体中的 `context`、`exhibitionId` 等字段不参与配置选择。
- 每个展厅拥有独立的轮询任务、启停状态、回程客户端与回程配置，互不影响；同一展厅重复启动不会创建第二个任务。
- 展厅 ID 只用于路由与配置变量名，不写入回程请求体。

## 使用

```bash
npm install
# 本地已有 .env；部署时从 .env.example 创建 .env 并填入产品提供的 Token、AGENT 与回程端口
npm test
npm start
```

`.env` 已被 Git 忽略，不能提交。默认启动端口为 `18031`，可用 `PORT` 覆盖；可选 `INGRESS_TIMEOUT_MS` 默认值为 `5000` 毫秒；可选 `POLLING_MAX_DURATION_HOURS` 控制回程轮询最长运行时长，默认值为 `10` 小时，可通过部署环境变量或 `.env`（如 `POLLING_MAX_DURATION_HOURS=10`）修改，取值必须为大于 0 的有限数值且换算为毫秒后不超过 `2147483647`（约 `596.52` 小时），非法或超限值会在启动时明确报错而不会静默改变行为。代码默认值固定为 `10` 小时；生产部署的 `.env` 可按产品要求覆盖（例如部署环境中出现 `POLLING_MAX_DURATION_HOURS=8`），实际运行时长以部署环境配置为准，不能用代码默认值推断。

必填配置：

```bash
# Token → 展厅ID 映射；A、B 两个展厅各一个 Token
HC_TOKEN_MAP=<A展厅Token>:exhibition-a,<B展厅Token>:exhibition-b

# 每个展厅一组回程配置
HC_HALL_EXHIBITION_A_AGENT=rs-demorg-secops
HC_HALL_EXHIBITION_A_INGRESS_HOST=127.0.0.1
HC_HALL_EXHIBITION_A_INGRESS_PORT=29876
HC_HALL_EXHIBITION_A_INGRESS_TOKEN=<A展厅回程鉴权Token>

HC_HALL_EXHIBITION_B_AGENT=rs-demorg-secops-b
HC_HALL_EXHIBITION_B_INGRESS_HOST=127.0.0.1
HC_HALL_EXHIBITION_B_INGRESS_PORT=29877
HC_HALL_EXHIBITION_B_INGRESS_TOKEN=<B展厅回程鉴权Token>
```

- 变量前缀规则：`HC_HALL_` + 展厅 ID 转大写、非字母数字字符转 `_`（如 `exhibition-a` → `HC_HALL_EXHIBITION_A_*`）。
- 两个展厅的 `AGENT` 不得相同，回程 `HOST:PORT` 也不得相同，否则启动直接失败（防止串台）。
- `HC_TOKEN_MAP` 中出现的每个展厅都必须提供完整的 `HC_HALL_*` 配置；未部署的展厅请从该执行器的映射中移除，否则启动失败（不做任何默认回退）。
- 示例值（`example-token-*`、`REPLACE_WITH_*`、`change-me-*`）会被启动校验拒绝，必须替换为真实 Token。
- 多个展厅共用同一 `TO` 时启动会输出告警；生产部署前必须确认接收方是否应按展厅区分。
- 仅当 `HC_TOKEN_MAP` 只映射一个展厅时，才允许用旧版 `AGENT`、`INGRESS_HOST`、`INGRESS_PORT`、`INGRESS_TOKEN` 作为该展厅的回退值；多展厅时每个展厅都必须显式配置。
- `HC_HALL_<展厅>_TO` 可选，用于覆盖该展厅的回程接收方 JID，缺省使用执行器内置默认值。

## 回程轮询指令接口

执行器启动后只监听 HTTP 端口，**默认不开启任何展厅的回程轮询**；由外部通过 `POST /api/commands` 携带 `X-HC-Token` 开启或关闭对应展厅的轮询。

请求体为 JSON 数组，元素为 `{ "action": "...", "params": {} }`：

```bash
curl -X POST http://127.0.0.1:18031/api/commands \
  -H "Content-Type: application/json" \
  -H "X-HC-Token: <A展厅Token>" \
  -d '[{"action":"启动园区AI安防智能体","params":{}}]'
# {"ok":true,"message":"polling started"}

curl -X POST http://127.0.0.1:18031/api/commands \
  -H "Content-Type: application/json" \
  -H "X-HC-Token: <A展厅Token>" \
  -d '[{"action":"取消园区AI安防智能体","params":{}}]'
# {"ok":true,"message":"polling stopped"}
```

| 指令（action） | 行为 |
| --- | --- |
| `启动园区AI安防智能体` | 开启该 Token 所属展厅的回程轮询；同一展厅重复调用不会创建多个轮询任务（返回 `polling already running`） |
| `取消园区AI安防智能体` | 停止该 Token 所属展厅的回程轮询；等待在途请求完成后停止（最长 `INGRESS_TIMEOUT_MS`）；重复调用返回 `polling already stopped` |

- 指令名称为《HC功能指令设计总表》中的正式名称（已确认）；睿司侧的指令注册与真实调用联调尚未完成，部署前需完成对应配置与联调。
- 也接受 `{"commands":[...]}` 信封格式（与指令执行器一致）；`params` 可省略或为空对象，内容会被忽略；信封内的 `context`/`exhibitionId` 不参与展厅选择。
- 未知 action、非法 JSON、空数组、仅含 action 的单个对象、`params` 非对象等返回 `400 {"ok":false,"error":"..."}`；`/api/commands` 使用非 POST 方法返回 `405`；其他路径返回 `404 {"status":"not_found"}`。
- 停止后再次发送启动指令会创建该展厅新的轮询任务，并从段落 01 第 1 条重新开始；`SIGINT`/`SIGTERM` 会中止所有展厅的在途请求并退出进程。
- 每个展厅从各自首次启动开始按 `POLLING_MAX_DURATION_HOURS` 计时，重复启动不会重置或延长该计时；到期后只自动停止该展厅（等待在途请求完成，语义与取消指令一致），HTTP 服务不退出，之后的启动指令会重新开始一轮完整计时。手动取消会清理该展厅的定时器。
- 原 `/api/polling/start`、`/api/polling/stop`、`/api/polling/status` 路由已移除，不再对外提供。
- 健康检查：`GET /health` 返回 HTTP `200` 与 `{"status":"ok"}`，不校验 Token，停止轮询后仍然可用。

**安全说明（本轮）**：`/api/commands` 已按 `X-HC-Token` 做应用层鉴权，但 `/health` 保持匿名只读。部署时仍应通过内网访问限制、防火墙、安全组或其他网络访问控制手段限制可访问执行器端口的来源。

## 正式固定轮询

正式剧本位于 `src/scripts/messages.js`，共 12 个段落、28 条消息。开启轮询后立即发送段落01第1条；同段相邻消息间隔 40 秒；每段最后一条后仅等待 12 分钟进入下一段；段落12后同样等待 12 分钟并回到段落01。没有额外的 round interval 或段间 40 秒。

回程请求为 `POST http://${HC_HALL_<展厅>_INGRESS_HOST}:${HC_HALL_<展厅>_INGRESS_PORT}/agent/send`，携带 JSON 与 `X-Auth-Token`（取该展厅的 `HC_HALL_<展厅>_INGRESS_TOKEN`）。HTTP 任意 2xx 均视为成功；单条失败会记录日志，后续消息和轮询继续执行。收到停止请求后等待在途请求结束，不再发送后续消息。
