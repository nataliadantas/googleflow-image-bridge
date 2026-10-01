#!/usr/bin/env node
/**
 * mcp-server.js：把「网页版 Google Flow 生图」封装成 MCP 工具，供 Agent 调用。
 *
 * 生图链路有两条：优先连接本地常驻服务（node flowimg.js serve，速度快）；
 * 服务未启动时退化为一次性 CLI 调用，每次需启动浏览器，慢 10~20 秒。
 *
 * 暴露的工具：
 *   generate_image(prompt, aspect_ratio?, model?, download_size?, timeout_sec?)        → { ok, path, elapsed_sec }
 *   generate_images(prompts, aspect_ratio?, model?, download_size?, timeout_sec?, parallel?) → 批量生图，每项带 ok、paths 或 error
 *   quota_info()                                                                       → 最近 3 小时通过本程序生成的图片数
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_URL = process.env.FLOWIMG_SERVER || 'http://127.0.0.1:3888';

/**
 * 走常驻服务生图：先探活 /health，存活才 POST /generate。
 * 服务不在时返回 null，由调用方退化为 CLI，而不是直接报错。
 * @param {string} prompt 提示词
 * @param {number} timeoutSec 生图超时秒数（HTTP 超时在此基础上放宽 60 秒）
 * @param {string|undefined} ratio 宽高比
 * @param {string|undefined} model 模型名
 * @param {string|undefined} res 下载分辨率（1k、2k、4k）
 * @returns {Promise<object|null>} 服务返回的 JSON；服务不可达返回 null
 */
async function viaServer(prompt, timeoutSec, ratio, model, res) {
  const health = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  if (!health || !health.ok) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.FLOWIMG_API_KEY) headers.Authorization = `Bearer ${process.env.FLOWIMG_API_KEY}`;
  // 服务侧不排队等限额（wait: false）：限额错误原样返回，由调用方按 retry_after 自行重试
  const resp = await fetch(`${SERVER_URL}/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, timeout: timeoutSec, aspect_ratio: ratio || undefined, model: model || undefined, res: res || undefined, wait: false }),
    signal: AbortSignal.timeout((timeoutSec + 60) * 1000),
  });
  return await resp.json();
}

/**
 * 退化为一次性 CLI 生图：以子进程执行 flowimg.js gen，取 stdout 最后一行作为结果 JSON。
 * 子进程报错时也先尝试从残留 stdout 里解析 JSON，解析不出才返回通用错误。
 * @param {string} prompt 提示词
 * @param {number} timeoutSec 生图超时秒数（子进程超时在此基础上放宽 90 秒）
 * @param {string|undefined} ratio 宽高比
 * @param {string|undefined} model 模型名
 * @param {string|undefined} res 下载分辨率（1k、2k、4k）
 * @returns {Promise<object>} 生图结果 JSON
 */
async function viaCli(prompt, timeoutSec, ratio, model, res) {
  const args = [path.join(__dirname, 'flowimg.js'), 'gen', prompt, '--timeout', String(timeoutSec)];
  if (ratio) args.push('--ratio', ratio);
  if (model) args.push('--model', model);
  if (res) args.push('--res', res);
  try {
    const { stdout } = await execFileP(
      process.execPath,
      args,
      { timeout: (timeoutSec + 90) * 1000, maxBuffer: 1024 * 1024, cwd: __dirname }
    );
    const line = stdout.trim().split('\n').pop();
    return JSON.parse(line);
  } catch (e) {
    const m = String(e.stdout || '').trim().split('\n').pop();
    if (m && m.startsWith('{')) return JSON.parse(m);
    return { ok: false, error: String(e.message || e) };
  }
}

// 包装成 MCP 工具返回结构（文本内容是美化后的 JSON）
function textResult(obj, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError };
}

/**
 * 走常驻服务批量生图：单请求 POST /batch，服务内部串行处理。
 * 超时按「每条 (timeout + 60s)」预估整批时长，另加 60 秒余量。
 * @param {string[]} prompts 提示词列表（上限 50）
 * @param {number} timeoutSec 单条生图超时秒数
 * @param {string|undefined} ratio 宽高比
 * @param {string|undefined} model 模型名
 * @param {string|undefined} res 下载分辨率（1k、2k、4k）
 * @returns {Promise<object|null>} 服务返回的 JSON；服务不可达返回 null
 */
async function viaServerBatch(prompts, timeoutSec, ratio, model, res, parallel) {
  const health = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  if (!health || !health.ok) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.FLOWIMG_API_KEY) headers.Authorization = `Bearer ${process.env.FLOWIMG_API_KEY}`;
  // 总时长按「条数 / 并行度」向上取整估算，再加 60 秒余量
  const waitMs = Math.ceil(prompts.length / (parallel || 1)) * (timeoutSec + 60) * 1000 + 60_000;
  const resp = await fetch(`${SERVER_URL}/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompts, timeout: timeoutSec, aspect_ratio: ratio || undefined, model: model || undefined, res: res || undefined, parallel: parallel || undefined, wait: false }),
    signal: AbortSignal.timeout(waitMs),
  });
  return await resp.json();
}

const server = new McpServer({ name: 'google-flow-image', version: '0.2.0' });

server.registerTool(
  'generate_image',
  {
    title: '网页版 Google Flow 生图',
    description:
      '通过用户已登录的网页版 Google Flow（Imagen / Nano Banana）生成图片。' +
      '返回本地保存的图片绝对路径。生成需要 30~120 秒，请勿频繁重试。' +
      '若返回 error_kind 为 rate_limit，请按 retry_after 秒数稍后再重试。',
    inputSchema: {
      prompt: z.string().describe('图片提示词，中英文均可'),
      aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe('宽高比，默认由页面当前设置决定'),
      model: z.string().optional().describe('页面模型菜单中的选项名，例如 "Nano Banana Pro"，默认使用服务端配置的默认模型'),
      download_size: z.enum(['1k', '2k', '4k']).optional().describe('下载分辨率：经详情页「下载媒体内容」取图，高档位未订阅时自动降档；缺省用快速 fetch（约 1024~1376px）'),
      timeout_sec: z.number().min(30).max(600).optional().describe('超时秒数，默认 240'),
    },
  },
  async ({ prompt, aspect_ratio, model, download_size, timeout_sec }) => {
    const timeoutSec = timeout_sec || 240;
    const result = (await viaServer(prompt, timeoutSec, aspect_ratio, model, download_size)) ?? (await viaCli(prompt, timeoutSec, aspect_ratio, model, download_size));
    if (result?.ok) return textResult(result);
    return textResult(result ?? { ok: false, error: '生图失败，无返回' }, true);
  }
);

server.registerTool(
  'generate_images',
  {
    title: '网页版 Google Flow 批量生图',
    description:
      '按提示词列表批量生成（串行，每张约 30~120 秒，请勿频繁重试）。' +
      '返回每项的 ok、paths 或 error；某项 error_kind 为 rate_limit 时按 retry_after 重试该项即可，其余项不受影响。',
    inputSchema: {
      prompts: z.array(z.string()).min(1).max(50).describe('提示词列表，上限 50 条'),
      aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe('宽高比，默认由页面当前设置决定'),
      model: z.string().optional().describe('页面模型菜单中的选项名，例如 "Nano Banana Pro"，默认使用服务端配置的默认模型'),
      download_size: z.enum(['1k', '2k', '4k']).optional().describe('下载分辨率，高档位未订阅时自动降档'),
      timeout_sec: z.number().min(30).max(600).optional().describe('单条超时秒数，默认 240'),
      parallel: z.number().min(1).max(4).optional().describe('并行度 1~4（默认 1：串行）。并行在同一个浏览器里开多个标签页同时生成，仅走常驻服务时生效'),
    },
  },
  async ({ prompts, aspect_ratio, model, download_size, timeout_sec, parallel }) => {
    const timeoutSec = timeout_sec || 240;
    const batch = await viaServerBatch(prompts, timeoutSec, aspect_ratio, model, download_size, parallel);
    if (batch) return textResult(batch, !batch.ok);
    // 服务不在：逐条走一次性 CLI（每条都要冷启动浏览器，建议先生成前先启动 serve）
    const results = [];
    for (let i = 0; i < prompts.length; i++) {
      const r = await viaCli(prompts[i], timeoutSec, aspect_ratio, model, download_size);
      results.push({ index: i, prompt: prompts[i].slice(0, 80), ok: !!r?.ok, paths: r?.paths, error: r?.error });
    }
    const succeeded = results.filter((r) => r.ok).length;
    return textResult({ ok: succeeded > 0, total: results.length, succeeded, failed: results.length - succeeded, results }, succeeded === 0);
  }
);

server.registerTool(
  'quota_info',
  {
    title: '查询生图使用情况',
    description: '返回最近 3 小时内通过本程序生成的图片数量（基于本地历史记录，仅供参考；Flow 官方限额以页面提示为准）。',
    inputSchema: {},
  },
  async () => {
    const history = path.join(__dirname, 'output', 'history.jsonl');
    let used = 0;
    const cutoff = Date.now() - 3 * 3600_000;
    if (fs.existsSync(history)) {
      for (const line of fs.readFileSync(history, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { if (new Date(JSON.parse(line).ts).getTime() >= cutoff) used++; } catch { /* 忽略坏行 */ }
      }
    }
    return textResult({ ok: true, used_last_3h: used });
  }
);

await server.connect(new StdioServerTransport());
