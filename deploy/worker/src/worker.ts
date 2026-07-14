import { signTencentRequest } from "./tc3";

type JobStatus = "submitting" | "queued" | "running" | "succeeded" | "failed" | "aborted";

interface JobRecord {
  id: string;
  ticker: string;
  tradeDate: string;
  analysts: string[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  invokeRequestId?: string;
  scfStatus?: string;
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  decision?: string;
  model?: string;
  report?: string;
  error?: string;
}

const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CALLBACK_BYTES = 2 * 1024 * 1024;
const ALL_ANALYSTS = ["market", "social", "news", "fundamentals", "policy", "hot_money", "lockup"];
const ACTIVE_STATUSES = new Set<JobStatus>(["submitting", "queued", "running"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;

  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    const [validUsername, validPassword] = await Promise.all([
      constantTimeEqual(username, env.ADMIN_USERNAME),
      constantTimeEqual(password, env.ADMIN_PASSWORD),
    ]);
    return validUsername && validPassword;
  } catch {
    return false;
  }
}

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="A-stock analysis", charset="UTF-8"',
    },
  });
}

async function parseJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("request body is too large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new Error("request body is too large");
  }
  return JSON.parse(body);
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function validateSubmission(value: unknown): { ticker: string; tradeDate: string } {
  if (!isRecord(value)) throw new Error("body must be an object");
  const ticker = stringField(value, "ticker")?.trim() ?? "";
  const tradeDate = stringField(value, "tradeDate")?.trim() ?? "";
  if (!/^\d{6}$/.test(ticker)) throw new Error("股票代码必须是 6 位数字");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || Number.isNaN(Date.parse(`${tradeDate}T00:00:00Z`))) {
    throw new Error("分析日期格式无效");
  }
  if (tradeDate > shanghaiToday()) throw new Error("分析日期不能晚于今天");
  return { ticker, tradeDate };
}

async function readJob(env: Env, id: string): Promise<JobRecord | null> {
  return env.JOBS.get<JobRecord>(`job:${id}`, "json");
}

async function writeJob(env: Env, job: JobRecord): Promise<void> {
  await env.JOBS.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
}

async function callTencent(
  env: Env,
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const signed = await signTencentRequest({
    action,
    payload,
    region: env.TENCENT_REGION,
    secretId: env.TENCENT_SECRET_ID,
    secretKey: env.TENCENT_SECRET_KEY,
  });
  const response = await fetch("https://scf.tencentcloudapi.com", {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });
  const data: unknown = await response.json();
  if (!isRecord(data) || !isRecord(data.Response)) {
    throw new Error("Tencent SCF returned an invalid response");
  }
  const error = data.Response.Error;
  if (isRecord(error)) {
    throw new Error(`${stringField(error, "Code") ?? "SCFError"}: ${stringField(error, "Message") ?? "request failed"}`);
  }
  if (!response.ok) throw new Error(`Tencent SCF HTTP ${response.status}`);
  return data.Response;
}

async function submitJob(request: Request, env: Env, url: URL): Promise<Response> {
  let submission: { ticker: string; tradeDate: string };
  try {
    submission = validateSubmission(await parseJsonBody(request, 16 * 1024));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "请求参数无效" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const job: JobRecord = {
    id: crypto.randomUUID(),
    ticker: submission.ticker,
    tradeDate: submission.tradeDate,
    analysts: ALL_ANALYSTS,
    status: "submitting",
    createdAt: now,
    updatedAt: now,
  };
  await writeJob(env, job);

  try {
    const invocation = await callTencent(env, "Invoke", {
      FunctionName: env.TENCENT_FUNCTION,
      Namespace: env.TENCENT_NAMESPACE,
      Qualifier: "$LATEST",
      InvocationType: "Event",
      ClientContext: JSON.stringify({
        job_id: job.id,
        ticker: job.ticker,
        trade_date: job.tradeDate,
        analysts: job.analysts,
        callback_url: `${url.origin}/api/callback`,
      }),
    });
    const result = isRecord(invocation.Result) ? invocation.Result : {};
    job.invokeRequestId = stringField(result, "FunctionRequestId");
    job.status = "queued";
    job.updatedAt = new Date().toISOString();
    await writeJob(env, job);
    return json({ job }, { status: 202 });
  } catch (error) {
    job.status = "failed";
    job.error = "任务提交到 SCF 失败";
    job.updatedAt = new Date().toISOString();
    await writeJob(env, job);
    console.error(JSON.stringify({
      message: "SCF invocation failed",
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return json({ error: job.error, job }, { status: 502 });
  }
}

async function refreshScfStatus(env: Env, job: JobRecord): Promise<JobRecord> {
  if (!job.invokeRequestId || !ACTIVE_STATUSES.has(job.status)) return job;
  try {
    const response = await callTencent(env, "GetAsyncEventStatus", {
      InvokeRequestId: job.invokeRequestId,
    });
    const result = isRecord(response.Result) ? response.Result : {};
    const scfStatus = stringField(result, "Status");
    if (!scfStatus || scfStatus === job.scfStatus) return job;

    job.scfStatus = scfStatus;
    job.updatedAt = new Date().toISOString();
    if (scfStatus === "RUNNING" && job.status === "queued") job.status = "running";
    if (scfStatus === "FAILED") {
      job.status = "failed";
      job.error = "SCF 任务执行失败，请查看函数日志";
    }
    if (scfStatus === "ABORTED") {
      job.status = "aborted";
      job.error = "SCF 任务已终止";
    }
    await writeJob(env, job);
  } catch (error) {
    console.error(JSON.stringify({
      message: "SCF status refresh failed",
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return job;
}

async function listJobs(env: Env): Promise<Response> {
  const listed = await env.JOBS.list({ prefix: "job:", limit: 50 });
  const values = await Promise.all(listed.keys.map((key) => env.JOBS.get<JobRecord>(key.name, "json")));
  const jobs = values
    .filter((job): job is JobRecord => job !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return json({ jobs });
}

async function callbackDigest(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function receiveCallback(request: Request, env: Env): Promise<Response> {
  const timestamp = request.headers.get("X-Job-Timestamp") ?? "";
  const providedSignature = request.headers.get("X-Job-Signature") ?? "";
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return json({ error: "stale callback" }, { status: 401 });
  }

  let body: string;
  try {
    const parsedLength = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(parsedLength) && parsedLength > MAX_CALLBACK_BYTES) {
      return json({ error: "callback is too large" }, { status: 413 });
    }
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_CALLBACK_BYTES) {
      return json({ error: "callback is too large" }, { status: 413 });
    }
  } catch {
    return json({ error: "invalid callback" }, { status: 400 });
  }

  const expectedSignature = await callbackDigest(env.CALLBACK_SECRET, timestamp, body);
  if (!(await constantTimeEqual(providedSignature, expectedSignature))) {
    return json({ error: "invalid callback signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "invalid callback JSON" }, { status: 400 });
  }

  const jobId = stringField(payload, "job_id") ?? "";
  const callbackStatus = stringField(payload, "status") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !["running", "succeeded", "failed"].includes(callbackStatus)) {
    return json({ error: "invalid callback payload" }, { status: 400 });
  }
  const job = await readJob(env, jobId);
  if (!job) return json({ error: "job not found" }, { status: 404 });

  job.status = callbackStatus as JobStatus;
  job.updatedAt = new Date().toISOString();
  job.startedAt = stringField(payload, "started_at") ?? job.startedAt;
  job.completedAt = stringField(payload, "completed_at") ?? job.completedAt;
  job.durationSeconds = numberField(payload, "duration_seconds") ?? job.durationSeconds;
  job.decision = stringField(payload, "decision") ?? job.decision;
  job.model = stringField(payload, "model") ?? job.model;
  job.report = stringField(payload, "report") ?? job.report;
  job.error = stringField(payload, "error") ?? job.error;
  await writeJob(env, job);
  console.log(JSON.stringify({ message: "job callback stored", jobId, status: job.status }));
  return json({ ok: true });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/callback" && request.method === "POST") {
    return receiveCallback(request, env);
  }
  if (!(await isAuthorized(request, env))) return unauthorized();

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, function: env.TENCENT_FUNCTION, region: env.TENCENT_REGION });
  }
  if (url.pathname === "/api/jobs" && request.method === "GET") return listJobs(env);
  if (url.pathname === "/api/jobs" && request.method === "POST") return submitJob(request, env, url);

  const detailMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
  if (detailMatch && request.method === "GET") {
    const id = detailMatch[1];
    if (!id) return json({ error: "job not found" }, { status: 404 });
    const job = await readJob(env, id);
    if (!job) return json({ error: "job not found" }, { status: 404 });
    return json({ job: await refreshScfStatus(env, job) });
  }
  return json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (!(await isAuthorized(request, env))) return unauthorized();
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({
        message: "unhandled request error",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: "internal server error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
