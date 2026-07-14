import DOMPurify from "dompurify";
import { createIcons, ExternalLink, LoaderCircle, Play, RefreshCw } from "lucide";
import { marked } from "marked";

type JobStatus = "submitting" | "queued" | "running" | "succeeded" | "failed" | "aborted";

interface Job {
  id: string;
  ticker: string;
  tradeDate: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  decision?: string;
  report?: string;
  error?: string;
}

const statusLabels: Record<JobStatus, string> = {
  submitting: "提交中",
  queued: "已排队",
  running: "分析中",
  succeeded: "已完成",
  failed: "失败",
  aborted: "已终止",
};
const activeStatuses = new Set<JobStatus>(["submitting", "queued", "running"]);

const form = requiredElement<HTMLFormElement>("job-form");
const tickerInput = requiredElement<HTMLInputElement>("ticker");
const dateInput = requiredElement<HTMLInputElement>("trade-date");
const submitButton = requiredElement<HTMLButtonElement>("submit");
const refreshButton = requiredElement<HTMLButtonElement>("refresh");
const jobsContainer = requiredElement<HTMLDivElement>("jobs");
const formMessage = requiredElement<HTMLParagraphElement>("form-message");
const health = requiredElement<HTMLSpanElement>("health");
const count = requiredElement<HTMLSpanElement>("job-count");
const dialog = requiredElement<HTMLDialogElement>("report-dialog");
const report = requiredElement<HTMLElement>("report");
const reportTitle = requiredElement<HTMLHeadingElement>("report-title");
const reportMeta = requiredElement<HTMLParagraphElement>("report-meta");

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element as T;
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = (await response.json()) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload;
}

function iconButton(label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "report-link";
  button.addEventListener("click", onClick);
  const iconElement = document.createElement("i");
  iconElement.dataset.lucide = icon;
  iconElement.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  button.append(iconElement, text);
  return button;
}

async function openReport(job: Job): Promise<void> {
  if (!job.report) return;
  reportTitle.textContent = `${job.ticker} 分析报告`;
  reportMeta.textContent = `${job.tradeDate} · ${job.decision ?? "决策已生成"}`;
  const rendered = await marked.parse(job.report, { gfm: true, breaks: false });
  report.innerHTML = DOMPurify.sanitize(rendered);
  dialog.showModal();
}

function renderJobs(jobs: Job[]): void {
  jobsContainer.replaceChildren();
  count.textContent = `${jobs.length} 项`;
  if (jobs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无分析任务";
    jobsContainer.append(empty);
    return;
  }

  for (const job of jobs) {
    const row = document.createElement("article");
    row.className = "job-row";

    const ticker = document.createElement("strong");
    ticker.textContent = job.ticker;
    const tradeDate = document.createElement("span");
    tradeDate.textContent = job.tradeDate;
    const status = document.createElement("span");
    status.className = `status status-${job.status}`;
    status.textContent = statusLabels[job.status];
    const created = document.createElement("time");
    created.dateTime = job.createdAt;
    created.textContent = formatTime(job.createdAt);
    const action = document.createElement("div");
    action.className = "job-action";
    if (job.report) action.append(iconButton("查看报告", "external-link", () => void openReport(job)));
    if (job.error) {
      const error = document.createElement("span");
      error.className = "job-error";
      error.title = job.error;
      error.textContent = "查看错误";
      action.append(error);
    }
    row.append(ticker, tradeDate, status, created, action);
    jobsContainer.append(row);
  }
  installIcons();
}

function installIcons(): void {
  createIcons({ icons: { ExternalLink, LoaderCircle, Play, RefreshCw } });
}

async function loadJobs(): Promise<void> {
  refreshButton.disabled = true;
  try {
    const response = await api<{ jobs: Job[] }>("/api/jobs");
    const jobs = await Promise.all(
      response.jobs.map(async (job) => {
        if (!activeStatuses.has(job.status)) return job;
        try {
          return (await api<{ job: Job }>(`/api/jobs/${job.id}`)).job;
        } catch {
          return job;
        }
      }),
    );
    renderJobs(jobs);
  } catch (error) {
    formMessage.textContent = error instanceof Error ? error.message : "任务列表加载失败";
    formMessage.dataset.kind = "error";
  } finally {
    refreshButton.disabled = false;
  }
}

async function checkHealth(): Promise<void> {
  try {
    await api<{ ok: boolean }>("/api/health");
    health.textContent = "服务正常";
    health.dataset.state = "ok";
  } catch {
    health.textContent = "服务异常";
    health.dataset.state = "error";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  formMessage.textContent = "正在提交";
  formMessage.dataset.kind = "pending";
  try {
    await api<{ job: Job }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ ticker: tickerInput.value.trim(), tradeDate: dateInput.value }),
    });
    formMessage.textContent = "任务已进入 SCF 队列";
    formMessage.dataset.kind = "success";
    await loadJobs();
  } catch (error) {
    formMessage.textContent = error instanceof Error ? error.message : "任务提交失败";
    formMessage.dataset.kind = "error";
  } finally {
    submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", () => void loadJobs());
requiredElement<HTMLButtonElement>("close-report").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

dateInput.value = shanghaiToday();
dateInput.max = dateInput.value;
installIcons();
void Promise.all([checkHealth(), loadJobs()]);
window.setInterval(() => void loadJobs(), 10_000);
