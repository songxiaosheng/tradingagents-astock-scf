# Cloudflare + 腾讯云 SCF 任务部署

本部署把浏览器入口、任务状态和报告展示放在 Cloudflare Worker，把多 Agent 计算放在腾讯云上海 SCF 异步任务函数。链路中没有常驻服务器。

## 架构

```text
浏览器
  -> Cloudflare Worker（Basic Auth、静态面板、API）
       -> 腾讯云 SCF Invoke API（异步 Event）
            -> TradingAgents A-stock 任务镜像
                 -> A 股公开数据源
                 -> OpenAI 兼容模型网关
            -> HMAC 回调 Cloudflare Worker
       -> Workers KV（任务状态与完整 Markdown 报告）
```

普通 HTTP 函数不适合本项目：一次完整分析需要多轮数据抓取和约 30-50 次模型调用。SCF 函数启用异步执行属性，Cloudflare 提交后立即返回任务 ID，页面通过 KV 状态轮询，不占用浏览器连接。

## 目录

```text
deploy/
├── scf/
│   ├── Dockerfile
│   ├── job.py
│   └── runtime.py
└── worker/
    ├── src/worker.ts
    ├── src/tc3.ts
    ├── src/client.ts
    └── wrangler.jsonc
```

## SCF 镜像

镜像必须构建为 `linux/amd64`：

```bash
docker buildx build \
  --platform linux/amd64 \
  --file deploy/scf/Dockerfile \
  --tag <TCR>/<namespace>/tradingagents-astock:<tag> \
  --push .
```

SCF 使用 `CustomImage`、`Event` 类型并开启 `AsyncRunEnable`。镜像端口设为 `-1`，容器通过 SCF Custom Runtime API 拉取事件。建议从 2 GB 内存和单实例并发 1 开始，根据真实峰值调整。

任务函数需要以下环境变量：

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI 兼容模型网关密钥 |
| `BACKEND_URL` | 网关地址，包含 `/v1` |
| `DEEP_THINK_LLM` | 深度模型或网关模型别名 |
| `QUICK_THINK_LLM` | 快速模型或网关模型别名 |
| `CALLBACK_URL` | Worker 的 `/api/callback` 地址 |
| `CALLBACK_SECRET` | SCF 与 Worker 共用的 HMAC Secret |

所有运行文件写入 `/tmp/tradingagents/<job-id>`。完整报告回传到 Workers KV，容器本地文件不作为持久化来源。

## Cloudflare Worker

```bash
cd deploy/worker
npm install
npm run check
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CALLBACK_SECRET
npx wrangler secret put TENCENT_SECRET_ID
npx wrangler secret put TENCENT_SECRET_KEY
npx wrangler deploy
```

腾讯云密钥应属于只允许调用指定 SCF 函数和查询异步状态的 CAM 子用户，禁止使用主账号密钥。`ADMIN_PASSWORD` 保护页面和提交 API；SCF 回调使用带五分钟时间窗的 HMAC-SHA256 独立认证。

## 验证

```bash
cd deploy/worker
npm run check
npx wrangler deploy --dry-run
npx wrangler check startup

cd ../..
python -m pytest tests/test_scf_job.py -q
```

部署后先验证 `/api/health`，再提交一个六位 A 股代码。任务应依次进入 `queued`、`running`、`succeeded`，成功后页面可直接打开 Markdown 报告。

## 回滚

- Worker：在 Cloudflare Deployments 中回滚到上一版本。
- SCF：把函数镜像 URI 更新为上一镜像摘要。
- 数据：Workers KV 记录保留 30 天，Worker 回滚不会删除既有报告。
