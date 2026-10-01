#!/usr/bin/env node
/**
 * flowimg.js：网页版 Google Flow 生图桥接程序。
 *
 * 用 patchright / Playwright 驱动真实 Chrome，操作网页版 Google Flow 生图。
 * 对外提供两类能力：命令行一次性操作（login、gen、quota 等），以及常驻 HTTP 服务（serve，含 OpenAI 兼容接口）。
 * 登录态持久化在 .chrome-profile/，生成结果与历史记录保存在 output/。
 *
 * 命令：
 *   node flowimg.js login                 首次登录：打开浏览器人工登录 Google，回车后保存会话
 *   node flowimg.js setproject [项目URL]  配置「生图」项目，此后所有生图收进该项目
 *   node flowimg.js setapikey [key]       为 serve 服务设置 API 密钥，缺省时自动生成随机密钥
 *   node flowimg.js setmodel "模型名"      设置默认模型（此后不带 --model 都用它）
 *   node flowimg.js gen "提示词" [选项]    生成图片，stdout 输出 JSON
 *   node flowimg.js batch 提示词文件       批量生图：txt 每行一条、jsonl 每行一个 JSON、json 数组；条目可带 n/ratio/model/res/timeout/wait
 *                                        --parallel N 并行度 1~4，同一浏览器开 N 个标签页同时生成（默认 1=串行）
 *   node flowimg.js serve [--port 3888]   常驻 HTTP 服务，推荐使用，含 OpenAI 兼容接口
 *   node flowimg.js quota                 查看最近 3 小时通过本程序生成的图片数量
 *   node flowimg.js probe [旗帜]          转储页面 DOM 结构到 output/debug/probe.json 供排障
 *   node flowimg.js doctor                检查登录态与浏览器环境
 *
 * gen 选项：
 *   --out 文件名      输出文件名，自动保存在 output/ 下，仅 n=1 时生效（扩展名按实际格式补齐）
 *   --timeout 秒数    默认 240
 *   --n 数量          批量生成 1~10 张，Flow 单次最多出 4 张，超过自动分批串行
 *   --ratio 比例      1:1、16:9、9:16、4:3、3:4，通过页面设置切换
 *   --model 模型名    页面模型菜单中的选项名，例如 "Nano Banana Pro"（不含 Lite 字样时自动排除 Lite）
 *   --res 分辨率      1k、2k、4k，经详情页「下载媒体内容」取图；高档位未订阅时自动降档；缺省用快速 fetch
 *   --wait            触发限额时排队等待恢复后自动重试
 *   --headless        尝试无头模式，容易触发人机验证，默认关闭
 *
 * probe 旗帜：
 *   --opensettings    先点开输入框旁的设置 chip 再转储，可看到设置菜单内部的控件
 *   --openmodel       先开设置面板再开模型下拉，转储菜单项
 *   --pickmodel 名称  在模型菜单中选中指定项后再转储
 *   --opencard        点开一张大图卡片进入详情页后转储
 *   --opendownload    配合 --opencard 使用，再点开「下载媒体内容」菜单后转储
 *
 * serve 接口（默认 127.0.0.1:3888，鉴权请求头 Authorization: Bearer <api_key>）：
 *   POST /generate                 生图主接口：prompt、n、aspect_ratio、model、res、timeout、wait、out
 *   POST /batch                    批量生图：prompts 数组（字符串或对象，上限 50 条）+ 公共选项 + parallel（1~4）
 *   POST /v1/images/generations    OpenAI 兼容端点：prompt、size、n、response_format
 *   GET  /health、/quota           健康检查与近 3 小时用量
 *   GET  /output/<文件名>          生成图片的静态访问
 *   GET  /debug/pageinfo           页面状态与截图（需鉴权）
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

// 优先使用 patchright（反检测补丁版 Playwright），未安装则回退 playwright
let chromium, DRIVER = 'playwright';
try {
  ({ chromium } = await import('patchright'));
  DRIVER = 'patchright';
} catch {
  ({ chromium } = await import('playwright'));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.chrome-profile'); // 持久化登录态
const OUTPUT_DIR = path.join(__dirname, 'output');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'history.jsonl');
const DEFAULT_URL = 'https://labs.google/fx/tools/flow';
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_PORT = 3888;

// 读取 config.json，文件缺失或解析失败时按空配置处理
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// 写回 config.json（保留两个空格缩进，便于人工查看与修改）
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// 生图入口：配置了「生图」项目的 URL 后，所有生图都收进该项目，不污染项目列表
function entryUrl() {
  return loadConfig().project_url || DEFAULT_URL;
}
const DEFAULT_TIMEOUT_MS = 240_000;
const VERSION = '0.4.0';
const DEFAULT_QUOTA_MAX_WAIT_MS = 3.4 * 3600_000;

// ---------- 浏览器 ----------

// 上次异常退出可能残留 Chrome 进程，占用 .chrome-profile 导致无法启动，这里予以清理
function killProfileZombies() {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'chrome*' -and $_.CommandLine -like '*chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 30_000 }, () => resolve()));
}

// serve 常驻服务是否已在运行：已在跑就不能再起第二个浏览器，两者会抢 .chrome-profile 的锁
async function serveInstanceRunning(port = DEFAULT_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

/**
 * 启动持久化浏览器上下文。
 * 优先使用系统 Chrome；起不来时先清理残留进程重试一次，仍不行再退到 Playwright 自带 Chromium。
 * @param {{ headless?: boolean }} [options] headless 为 true 时尝试无头模式（容易触发人机验证）
 * @returns {Promise<object>} 绑定到 .chrome-profile 的浏览器上下文
 */
async function launchContext({ headless = false } = {}) {
  // Flow 前端布局对窗口宽度敏感（参考 gflow-cli 经验），固定 1920x1080
  const opts = {
    headless,
    viewport: { width: 1920, height: 1080 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', headless ? '' : '--start-maximized'].filter(Boolean),
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', ...opts });
  } catch (e) {
    console.error('[warn] 系统 Chrome 通道启动失败：' + String(e.message || e).split('\n')[0]);
    if (await serveInstanceRunning()) {
      throw new Error(`检测到生图服务(serve)正在运行并占用浏览器，请直接通过服务调用生图，不用单独启动。`);
    }
    console.error('[warn] 清理残留的浏览器进程后重试...');
    await killProfileZombies();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', ...opts });
    } catch (e2) {
      console.error('[warn] 重试仍失败，改用 Playwright 自带 Chromium：' + String(e2.message || e2).split('\n')[0]);
      return await chromium.launchPersistentContext(PROFILE_DIR, opts);
    }
  }
}

// ---------- 页面元素 ----------

// 打开页面：网络抖动时自动重试（例如代理切换节点导致的 ERR_NETWORK_CHANGED），其余错误直接抛出
async function gotoWithRetry(page, url, { attempts = 3, waitUntil = 'domcontentloaded', timeout = 60_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await page.goto(url, { waitUntil, timeout });
    } catch (e) {
      const msg = String(e.message || e);
      if (i >= attempts || !/ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_ABORTED/i.test(msg)) throw e;
      console.error(`[warn] 页面加载失败，3 秒后重试（${i}/${attempts - 1}）：${msg.split('\n')[0]}`);
      await page.waitForTimeout(3000);
    }
  }
}

// 输入框的多重回退选择器：
// 输入框本体是 Slate.js / ProseMirror 富文本（contenteditable div），textarea 只是兜底。
// textarea 回退必须排除 #g-recaptcha-response 等隐藏的验证码 textarea：它们常驻页面且不可见，一旦命中点击必然超时。
const COMPOSER_SEL = 'div[role="textbox"], div[contenteditable="true"], textarea:not([name^="g-recaptcha"]):not([id^="g-recaptcha"])';
// Playwright 定位用的可见态变体（querySelector 不认 :visible 伪类，evaluate 里仍用上面的原版）
const visibleVariant = (sel) => sel.split(',').map((s) => s.trim() + ':visible').join(',');
const COMPOSER_VISIBLE_SEL = visibleVariant(COMPOSER_SEL);
// 提交按钮图标是 Material Symbols 连字 "arrow_forward"；文案态为 "arrow_forward Create"；新界面 aria-label 为「开始生成」
const SUBMIT_SEL = 'button[aria-label="开始生成"], button[aria-label*="Generate" i], button[aria-label*="Create" i], button[aria-label*="Submit" i], button[aria-label*="生成" i], button[type="submit"], button:has-text("arrow_forward")';
const SUBMIT_VISIBLE_SEL = visibleVariant(SUBMIT_SEL);
// 生成设置入口（旧界面 labs.google）：带 crop_* 图标的 aria-haspopup 菜单（crop_16_9、crop_1_1、crop_square 等）
const SETTINGS_TRIGGER_SEL = "button[aria-haspopup='menu']:has(i:text-matches('^crop_', ''))";
// 生成设置入口（新界面 flow.google.com）：输入框旁的设置 chip，点开后是 radio 面板
const SETTINGS_CHIP_SEL = "button[aria-label='设置触发器'], button[aria-label*='Settings' i]:has(i:has-text('crop_'))";
// 模型下拉触发按钮（新界面：aria-label「选择模型系列」，图标是 <mat-icon>；旧界面图标是 <i>，用 arrow_drop_down 文案兜底）
const MODEL_TRIGGER_SEL = "button[aria-label*='选择模型'], button[aria-label*='model' i][aria-haspopup], button[aria-haspopup='menu']:has-text('arrow_drop_down')";

// 宽高比在页面设置菜单中的可选标签（labs 旧界面 role=tab 的文案，1:1 有多个别名）
const RATIO_ALIASES = {
  '16:9': ['16:9'],
  '9:16': ['9:16'],
  '4:3': ['4:3'],
  '3:4': ['3:4'],
  '1:1': ['1:1', 'Square', '1×1'],
};

// 能力探测：报告当前页面实际命中了哪些元素（健康检查时用于判断前端是否改版）
async function probeCapabilities(page) {
  return page.evaluate(({ c, s, st }) => ({
    composer: !!document.querySelector(c),
    submit: !!document.querySelector(s),
    settings: [...document.querySelectorAll("button[aria-haspopup='menu']")].some((b) =>
      [...b.querySelectorAll('i')].some((i) => /^crop_/.test((i.innerText || '').trim()))),
    generated_img_count: [...document.querySelectorAll('img[alt="Generated image"]')].length,
  }), { c: COMPOSER_SEL, s: SUBMIT_SEL, st: SETTINGS_TRIGGER_SEL });
}

// 等待提示词输入框渲染出来并可见，超时返回 false（多半未登录或页面尚未加载完）
async function waitForComposer(page, timeoutMs = 30_000) {
  try {
    await page.waitForSelector(COMPOSER_VISIBLE_SEL, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// Cookie 弹窗、引导浮层等会挡住提交按钮（被拦截的点击会被静默吞掉），进项目后先逐个清掉
async function dismissOverlays(page) {
  for (const text of ['OK, got it', '知道了', 'Accept all', '接受全部', '同意', 'Got it']) {
    const btn = page.locator(`button:visible:has-text("${text}")`).first();
    if (await btn.count()) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

// Agent 模式会移除整个媒体面板，导致看不到生成结果，需要关掉
async function dismissAgentPill(page) {
  try {
    for (const btn of await page.locator('button[aria-pressed="true"]').all()) {
      const text = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, '');
      if (/agent/i.test(text)) { await btn.click(); await page.waitForTimeout(800); return; }
    }
  } catch { /* 忽略 */ }
}

/**
 * 点开模型下拉并选中指定项。
 * 菜单项用子串匹配，请求 Pro 时会被 Lite 变体误命中，所以 model 不含 lite 字样时额外排除 Lite 项。
 * 选模型失败不阻断生成，静默降级为页面当前模型。
 * @param {object} page 页面实例
 * @param {string|null} model 页面模型菜单中的选项名，为空则直接跳过
 * @returns {Promise<void>} 无返回值，效果体现在页面模型选择上
 */
async function clickModelMenuItem(page, model) {
  if (!model) return;
  try {
    const trigger = page.locator(MODEL_TRIGGER_SEL).first();
    if (!(await trigger.count())) return;
    await trigger.click();
    await page.waitForTimeout(600);
    let items = page.locator(`:is([role='menuitem'],[role='option'],li):has-text("${model}")`);
    if (!/lite/i.test(model)) items = items.filter({ hasNotText: 'Lite' });
    const item = items.first();
    if (await item.count()) await item.click().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch { /* 模型选择失败不阻断生成 */ }
}

/**
 * 打开页面上的生成设置，应用 Image 模式、宽高比、数量、模型。
 * 两种宿主并存：labs.google 旧界面是「crop_* 图标菜单 + tab」，flow.google.com 新界面是「chip + radio 面板」，两套路径都要兼容。
 * @param {object} page 页面实例
 * @param {{ ratio?: string|null, count?: number, model?: string|null }} [options] ratio 目标宽高比，count 单次张数（1~4），model 模型名
 * @returns {Promise<void>} 找不到任何设置入口时抛错，个别项点不中只告警
 */
async function applyGenerationSettings(page, { ratio = null, count = 1, model = null } = {}) {
  // —— 旧界面（labs.google）：crop_* 图标的设置菜单 ——
  const oldTrigger = page.locator(SETTINGS_TRIGGER_SEL).first();
  if (await oldTrigger.count()) {
    await oldTrigger.click();
    await page.waitForTimeout(600);

    // 1) 切到 Image 模式（tab 只在菜单打开后才渲染到 DOM）
    for (const sel of ["[role='tab'][aria-controls*='IMAGE']", "[role='tab']:has-text('Image')", "[role='tab']:has(i:has-text('image'))"]) {
      const tab = page.locator(sel).first();
      if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(400); break; }
    }

    // 2) 宽高比
    if (ratio) {
      for (const label of RATIO_ALIASES[ratio] || [ratio]) {
        const tab = page.locator(`[role='tab']:has-text("${label}")`).first();
        if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(200); break; }
      }
    }

    // 3) 单次出图数量（1~4；标签文案有 x1 和 1x 两个版本）
    if (count >= 1 && count <= 4) {
      for (const label of [`x${count}`, `${count}x`]) {
        const tab = page.locator(`[role='tab']:has-text("${label}")`).first();
        if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(200); break; }
      }
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await clickModelMenuItem(page, model); // 旧界面模型下拉在画布区域
    return;
  }

  // —— 新界面（flow.google.com）：设置 chip（「设置触发器」），点开弹出 radio 面板 ——
  const chip = page.locator(SETTINGS_CHIP_SEL).first();
  if (!(await chip.count())) {
    throw new Error('未找到生成设置入口（旧版 crop_* 菜单与设置 chip 均未命中），按页面默认值生成');
  }
  await chip.click();
  await page.waitForTimeout(800);

  // 点 radio 并等页面确实选中；选中状态读不出就只告警不阻断（部分版本用 class 而不是 aria-checked 表示选中）
  const clickRadio = async (loc, label) => {
    if (!(await loc.count())) { console.error(`[warn] 设置项「${label}」未找到，按页面当前值生成`); return; }
    await loc.click().catch(() => {});
    await page.waitForTimeout(400);
    const checked = await loc.getAttribute('aria-checked').catch(() => null);
    const cls = ((await loc.getAttribute('class').catch(() => '')) || '');
    if (checked !== 'true' && !/checked|selected|active/i.test(cls)) console.error(`[warn] 设置项「${label}」点击后未能确认选中`);
  };

  // 图片模式（radio：中文「图片」/ 英文「Image」；新界面图标是 <mat-icon> 不是 <i>，按文案匹配更稳）
  await clickRadio(
    page.locator('button[role="radio"]:has-text("图片"), button[role="radio"]:has-text("Image"), button[role="radio"]:has-text("Photo")').first(),
    '图片模式'
  );

  // 宽高比（radio 文案含 16:9 / 4:3 / 1:1 / 3:4 / 9:16）
  if (ratio) await clickRadio(page.locator(`button[role="radio"]:has-text("${ratio}")`).first(), `宽高比 ${ratio}`);

  // 数量（radio：x1~x4；用子串匹配，组件内部有的渲染成 "x1" 有的带换行）
  if (count >= 1 && count <= 4) await clickRadio(page.locator(`button[role="radio"]:has-text("x${count}")`).first(), `数量 x${count}`);

  // 模型（面板内的「选择模型系列」下拉，必须先保持面板打开）
  await clickModelMenuItem(page, model);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 从 chip 文案反查设置是否真正生效（chip 显示「模型 <比例图标名> xN」，图标名与数值不一致：crop_square=1:1 等）
  const RATIO_CHIP_TOKENS = {
    '16:9': ['16:9', '16_9', 'crop_16_9'],
    '9:16': ['9:16', '9_16', 'crop_9_16'],
    '4:3': ['4:3', '4_3', 'crop_landscape'],
    '3:4': ['3:4', '3_4', 'crop_portrait'],
    '1:1': ['1:1', '1_1', 'crop_square'],
  };
  const chipText = ((await chip.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  if (ratio && !(RATIO_CHIP_TOKENS[ratio] || [ratio]).some((t) => chipText.includes(t))) {
    console.error(`[warn] chip 上未见宽高比 ${ratio}（当前：${chipText.slice(0, 60)}）`);
  }
  if (count >= 1 && count <= 4 && !chipText.includes(`x${count}`)) {
    console.error(`[warn] chip 上未见数量 x${count}（当前：${chipText.slice(0, 60)}），页面可能按默认张数出图`);
  }
}


/**
 * 扫描页面上的告警条、toast、横幅与失败卡片，识别限额、限流或生成失败。
 * 只看末尾几条告警节点，并跳过其中已嵌生成结果的节点，避免把正常结果卡误报成错误。
 * @param {object} page 页面实例
 * @returns {Promise<string|null>} 命中时返回错误文案（截断到 300 字符），无异常返回 null
 */
function detectError(page) {
  return page.evaluate(() => {
    const patterns = /unusual activity|couldn'?t (create|generate)|failed to (create|generate)|try again later|rate.?limit|too many|running low|out of (credits|images)|limit|quota|出错了|稍后再试|暂时无法/i;
    const nodes = [...document.querySelectorAll('[role="alert"], .toast, [class*="toast"], [class*="banner"]')].slice(-5);
    for (const n of nodes) {
      const t = (n.innerText || '').trim();
      if (t && patterns.test(t) && !n.querySelector('img[alt="Generated image"]')) return t.slice(0, 300);
    }
    // 生成失败的卡片带 Retry 按钮，出现即视为失败
    const retry = [...document.querySelectorAll('button')].find((b) => /^retry$/i.test((b.innerText || '').trim()) && b.offsetParent);
    if (retry) return '检测到生成失败卡片（Retry 按钮）';
    return null;
  });
}

// ---------- 生图核心流程 ----------

/**
 * 开始生成前安装「新图监听器」，把本批新出现的 img 节点识别为本批生成结果。
 * 项目页会把所有历史图片列成网格，图片 URL 又是每次渲染都变化的签名地址，不能用全局 src 快照做差集。
 * 改用两点保证只取本批：
 *   1) MutationObserver 只收集提交后真正被加入 DOM 的 img 节点（老图文件不挪窝，节点身份稳定）；
 *   2) URL 路径 token 作为去重键（/asb/ANqvLO…、lh3.google 的路径），排除少数因虚拟列表重挂载而「看起来像新节点」的老图。
 * @param {object} page 页面实例，收集结果挂在 window.__flowWatch 上
 * @returns {Promise<void>} 无返回值，结果由 readImageWatcher 读取
 */
async function startImageWatcher(page) {
  await page.evaluate(() => {
    const keyOf = (src) => {
      try { return new URL(src, location.href).pathname; } catch { return src; }
    };
    const baseline = [...document.querySelectorAll('img')]
      .map((el) => keyOf(el.currentSrc || el.src)).filter(Boolean);
    const imgs = new Set();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes || []) {
          if (n.tagName === 'IMG') imgs.add(n);
          else if (n.querySelectorAll) n.querySelectorAll('img').forEach((i) => imgs.add(i));
        }
        if (m.type === 'attributes' && m.target && m.target.tagName === 'IMG') imgs.add(m.target);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    window.__flowWatch = { baseline, imgs };
  });
}

/**
 * 读取监听器收集到的本批新图：只保留仍在 DOM 中、有地址、且不在基线里的节点，按 URL 路径去重。
 * @param {object} page 页面实例
 * @returns {Promise<Array<{src: string, loaded: boolean}>>} 新图清单；loaded 为 true 表示图片已完整加载
 */
function readImageWatcher(page) {
  return page.evaluate(() => {
    const w = window.__flowWatch;
    if (!w) return [];
    const keyOf = (src) => {
      try { return new URL(src, location.href).pathname; } catch { return src; }
    };
    const seen = new Set();
    const out = [];
    for (const el of w.imgs) {
      if (!el.isConnected) continue;
      const src = el.currentSrc || el.src;
      if (!src) continue;
      const key = keyOf(src);
      if (!key || seen.has(key) || w.baseline.includes(key) || w.baseline.includes(src)) continue;
      seen.add(key);
      out.push({ src, loaded: el.complete && el.naturalWidth >= 256 });
    }
    return out;
  });
}

/**
 * 核验一张候选图是不是「本次提示词」生成的。
 * 项目网格会实时同步别处手动生成的图片，不能只看见新图就信；做法是点卡片上的「重复使用提示」按钮，
 * 卡片原文会被填进输入框，与提示词样本比对后再清空输入框。
 * @param {object} page 页面实例
 * @param {string} src 候选图的完整地址
 * @param {string} snippet 提示词比对样本（去空白后的前 12 个字符）
 * @returns {Promise<boolean|null>} 核验结论；按钮或输入框不可用时返回 null，表示核验机制不可用，调用方应降级而不是拒绝
 */
async function verifyCardPrompt(page, src, snippet) {
  const clicked = await page.evaluate((imgSrc) => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const BTN = 'button[aria-label*="重复使用提示"], button[aria-label*="Reuse" i], button[aria-label*="提示" i][aria-label*="使" i]';
    const el = [...document.querySelectorAll('img')].find((i) => (i.currentSrc || i.src) === imgSrc);
    if (!el) return false;
    let card = el;
    let btn = null;
    for (let depth = 0; depth < 9 && card && card !== document.body; depth++) {
      btn = card.querySelector(BTN);
      if (btn) break;
      card = card.parentElement;
    }
    if (!btn) return false;
    btn.click();
    return true;
  }, src);
  if (!clicked) return null;

  const composer = page.locator(COMPOSER_VISIBLE_SEL).first();
  let text = '';
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(400);
    text = await composer.innerText().catch(() => '');
    if (text && text.trim()) break;
  }
  // 清空输入框，避免影响后续操作
  await composer.click().catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  if (!text || !text.trim()) return null;
  return text.replace(/\s+/g, '').includes(snippet);
}

/**
 * 在页面上完成一次完整生图：进项目、应用设置、输提示词、提交、轮询直到拿齐本批新图。
 * 提交成功的判据是输入框被清空（被浮层拦截的点击不算数）；新图要逐张过 verifyCardPrompt 核验。
 * @param {object} page 页面实例
 * @param {string} prompt 提示词
 * @param {{ want?: number, ratio?: string|null, model?: string|null }} [genOpts] want 期望张数，ratio 宽高比，model 模型名
 * @param {number} [timeoutMs] 总超时毫秒数
 * @returns {Promise<string[]>} 本批图片的 src 列表（最多 want 张）
 */
async function generateOnPage(page, prompt, { want = 1, ratio = null, model = null } = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await gotoWithRetry(page, entryUrl());
  await page.waitForTimeout(1500); // 等前端水合
  if (!(await waitForComposer(page))) {
    throw new Error('NOT_LOGGED_IN: 未找到输入框。请先运行: node flowimg.js login （也可能页面还没加载完或账号被改用 flow.google.com 新界面）');
  }
  await dismissOverlays(page);
  await dismissAgentPill(page);

  // 设置 Image 模式、宽高比、数量、模型；页面结构不支持时降级为页面默认值
  try {
    await applyGenerationSettings(page, { ratio, count: Math.min(4, want), model });
  } catch (e) {
    console.error('[warn] ' + String(e.message || e));
  }

  // 网格渲染稳定后再装监听器：此后出现在 DOM 里的 img 才是本批的
  await page.waitForTimeout(2500);
  await startImageWatcher(page);

  // 逐字输入：整段瞬间填充容易触发 Google 的「unusual activity」机器人判定
  const composer = page.locator(COMPOSER_VISIBLE_SEL).first();
  await composer.click();
  await page.keyboard.type(prompt, { delay: 15 });

  // 等提交按钮可用后点击；点击后以「输入框被清空」为提交成功的判据（浮层拦截的点击不能算数）
  let submitted = false;
  const submitBtn = page.locator(SUBMIT_VISIBLE_SEL).first();
  for (let i = 0; i < 30 && !submitted; i++) {
    if (await submitBtn.isEnabled().catch(() => false)) {
      await submitBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const remaining = await composer.innerText().catch(() => '');
      submitted = !remaining.trim();
      if (!submitted) await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  if (!submitted) throw new Error('SUBMIT_FAILED: 提交按钮一直不可点击，且 Enter 也未能提交');

  const deadline = Date.now() + timeoutMs;
  const snippet = prompt.replace(/\s+/g, '').slice(0, 12); // 卡片提示词比对样本（原文可能被截断，只比前 12 个字符）
  const verdict = new Map(); // src → 核验结论（只记 true / false，null 不记以便重试）
  let verifyBroken = false;
  let lastKey = '';
  let stableCount = 0;
  let lastWatched = [];

  while (Date.now() < deadline) {
    const err = await detectError(page);
    if (err) throw new Error('FLOW_ERROR: ' + err);

    const watched = await readImageWatcher(page);
    lastWatched = watched;
    const ready = watched.filter((e) => e.loaded).map((e) => e.src);

    // 逐张核验候选图对应的卡片提示词：项目网格会实时同步手动生成的图片，不能看见新图就信
    if (!verifyBroken) {
      let nullCount = 0;
      for (const src of ready) {
        if (verdict.has(src)) continue;
        const v = await verifyCardPrompt(page, src, snippet).catch(() => null);
        if (v === null) { nullCount++; continue; }
        verdict.set(src, v);
      }
      if (ready.length > 0 && nullCount === ready.length && verdict.size === 0) {
        verifyBroken = true;
        console.error('[warn] 卡片「重复使用提示」核验不可用，将按出现顺序直接取图（期间请勿在别处手动生图）');
      }
    }

    const accepted = verifyBroken ? ready : ready.filter((s) => verdict.get(s) === true);
    const key = accepted.join('|');
    if (accepted.length >= want) {
      // 出图数量达标且 2 轮轮询内 src 列表不再变化，视为本批生成完成
      if (key === lastKey) { stableCount += 1; if (stableCount >= 2) return accepted.slice(0, want); }
      else { lastKey = key; stableCount = 0; }
    } else {
      lastKey = key;
      stableCount = 0;
    }
    await page.waitForTimeout(1500);
  }
  // 页面实际出图数可能少于预想（数量按钮没点中），拿到一张完整的也先交付
  const acceptedFinal = verifyBroken
    ? lastWatched.filter((e) => e.loaded).map((e) => e.src)
    : lastWatched.filter((e) => e.loaded && verdict.get(e.src) === true).map((e) => e.src);
  if (acceptedFinal.length > 0) {
    console.error(`[warn] 超时但已有 ${acceptedFinal.length} 张完整图片，先行返回`);
    return acceptedFinal.slice(0, want);
  }
  throw new Error(`TIMEOUT: ${Math.round(timeoutMs / 1000)} 秒内未生成完成`);
}

/**
 * 保存一张图片到 output/。
 * 优先在页面内 fetch 取字节（同源、自动带登录 Cookie），失败时改用浏览器上下文的 request；
 * 按文件头魔数识别真实格式补扩展名，同一秒内的同名文件自动加序号避免互相覆盖。
 * @param {object} context 浏览器上下文（页面内 fetch 失败时的备选下载通道）
 * @param {object} page 页面实例
 * @param {string} src 图片地址
 * @param {string} prompt 提示词，用于生成文件名 slug
 * @param {string|null} outName 指定输出文件名，为空则按「时间戳_slug」自动命名
 * @returns {Promise<string>} 保存后的文件路径
 */
async function saveImage(context, page, src, prompt, outName) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const slug = (prompt.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'image';
  const ts = new Date().toISOString().replace(/[:T]/g, '').slice(0, 14);

  let buf = null;
  try {
    const b64 = await page.evaluate(async (imgSrc) => {
      const r = await fetch(imgSrc, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const bytes = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, src);
    buf = Buffer.from(b64, 'base64');
  } catch {
    const resp = await context.request.get(src, { timeout: 120_000 });
    if (!resp.ok()) throw new Error(`下载图片失败: HTTP ${resp.status()}`);
    buf = await resp.body();
  }

  let ext = '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
  else if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ext = '.webp';
  else if (!(buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50)) ext = '.jpg'; // 非 PNG magic 一律按 jpg

  const name = outName
    ? (/\.(png|jpe?g|webp)$/i.test(outName) ? outName : outName + ext)
    : `${ts}_${slug}${ext}`;
  let outPath = path.join(OUTPUT_DIR, name);
  // 同一批多张图可能落在同一秒，文件名相同会互相覆盖，自动加序号
  for (let i = 2; fs.existsSync(outPath); i++) {
    outPath = path.join(OUTPUT_DIR, name.replace(ext, `_${i}${ext}`));
  }
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * 通过详情页的「下载媒体内容」按指定分辨率取图：点卡片进 /edit/ 详情 → 开下载菜单 → 选 1K / 2K / 4K。
 * 高档位未订阅时菜单项是禁用的，自动降一档再试；全程捕获下载事件拿原始文件。
 * @param {object} page 页面实例
 * @param {string} src 目标图片地址（先在网格里点开它进详情页）
 * @param {string} res 期望分辨率：1k、2k、4k
 * @param {string} prompt 提示词，用于生成文件名 slug
 * @param {string|null} outName 指定输出文件名，为空则自动命名
 * @returns {Promise<string|null>} 保存路径；未成功返回 null，由调用方回退普通取图
 */
async function saveImageViaDownload(page, src, res, prompt, outName) {
  const wanted = { '4k': ['4K', '2K', '1K'], '2k': ['2K', '1K'], '1k': ['1K'] }[String(res).toLowerCase()] || null;
  if (!wanted) return null;

  const clicked = await page.evaluate((imgSrc) => {
    const el = [...document.querySelectorAll('img')].find((i) => (i.currentSrc || i.src) === imgSrc);
    if (!el) return false;
    el.click();
    return true;
  }, src);
  if (!clicked) return null;
  try {
    await page.waitForURL(/\/edit\//, { timeout: 8000 });
  } catch {
    return null;
  }
  await page.waitForTimeout(1500);

  let outPath = null;
  try {
    const menuBtn = page.locator('button[aria-label*="下载媒体内容"], button[aria-label*="Download" i]').first();
    if (await menuBtn.count()) {
      await menuBtn.click();
      await page.waitForTimeout(700);
      for (const label of wanted) {
        const item = page.locator(`[role="menuitem"]:has-text("${label}")`).first();
        if (!(await item.count())) continue;
        if (!(await item.isEnabled().catch(() => false))) {
          console.error(`[warn] ${label} 未对当前账号开放，尝试更低一档`);
          continue;
        }
        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 90_000 }),
            item.click(),
          ]);
          const slug = (prompt.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'image';
          const ts = new Date().toISOString().replace(/[:T]/g, '').slice(0, 14);
          const ext = path.extname(download.suggestedFilename() || '') || '.png';
          const name = outName
            ? (/\.(png|jpe?g|webp)$/i.test(outName) ? outName : outName + ext)
            : `${ts}_${slug}${ext}`;
          fs.mkdirSync(OUTPUT_DIR, { recursive: true });
          outPath = path.join(OUTPUT_DIR, name);
          for (let i = 2; fs.existsSync(outPath); i++) outPath = path.join(OUTPUT_DIR, name.replace(ext, `_${i}${ext}`));
          await download.saveAs(outPath);
          break;
        } catch (e) {
          console.error(`[warn] ${label} 下载失败：${String(e.message || e).split('\n')[0]}`);
        }
      }
    }
  } finally {
    await page.goBack().catch(() => {});
    await page.waitForTimeout(1200);
  }
  return outPath;
}

// 追加一条生成记录到 output/history.jsonl（quota 依它统计近 3 小时用量）
function recordHistory(prompt, imgPath, elapsedSec) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify({
    ts: new Date().toISOString(), prompt: prompt.slice(0, 200), path: imgPath, elapsed_sec: elapsedSec,
  }) + '\n');
}

// 统计最近 hours 小时内 history.jsonl 中的生成条数
export function countRecent(hours = 3) {
  if (!fs.existsSync(HISTORY_FILE)) return { used: 0, since: null };
  const cutoff = Date.now() - hours * 3600_000;
  let used = 0;
  for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (new Date(rec.ts).getTime() >= cutoff) used++;
    } catch { /* 忽略坏行 */ }
  }
  return { used, since: new Date(cutoff).toISOString() };
}

// 登录态失效时：把浏览器窗口顶到最前，等待人工重新登录或通过人机验证，完成后自动继续
async function interactiveRelogin(page, { timeoutMs = 300_000 } = {}) {
  console.error('[需要人工介入] 登录态失效，请在弹出的浏览器窗口中重新登录 Google 账号或通过人机验证（5 分钟内有效）...');
  await page.bringToFront().catch(() => {});
  await gotoWithRetry(page, DEFAULT_URL).catch(() => {});
  const ok = await waitForComposer(page, timeoutMs);
  if (!ok) throw new Error('RELOGIN_TIMEOUT: 等待重新登录超时，请重试');
  console.error('[已恢复] 检测到登录，继续刚才的生图任务。');
}

/**
 * 带一次重登机会的生图：报 NOT_LOGGED_IN 时等待人工重新登录 Google 或通过人机验证，然后原样重试。
 * 只有有头模式才能人工介入；无头模式无法弹窗，直接抛错。
 * @param {object} page 页面实例
 * @param {string} prompt 提示词
 * @param {object} genOpts 透传给 generateOnPage 的生图参数
 * @param {number} timeoutMs 总超时毫秒数
 * @param {{ headless?: boolean }} [options] headless 为 true 时不做重登
 * @returns {Promise<string[]>} 本批图片的 src 列表
 */
async function generateWithRelogin(page, prompt, genOpts, timeoutMs, { headless = false } = {}) {
  try {
    return await generateOnPage(page, prompt, genOpts, timeoutMs);
  } catch (e) {
    if (headless || !/NOT_LOGGED_IN/.test(String(e.message))) throw e;
    await interactiveRelogin(page);
    return await generateOnPage(page, prompt, genOpts, timeoutMs);
  }
}

// ---------- 限额感知 ----------

/**
 * 从报错文案判断是否触发限额，并计算需要排队等待的时长。
 * 能解析 "try again at 3:05 PM" 这类时刻文案与 "in 45 minutes" 这类相对时长；
 * 两种都解析不出时按 15 分钟后重试。
 * @param {string} errText 错误文案
 * @returns {number|null} 需要等待的毫秒数；不是限额类错误返回 null
 */
function quotaWaitMs(errText) {
  if (!/limit|quota|too many|running low|out of (credits|images)/i.test(errText)) return null;
  // 解析 "try again at 3:05 PM" / "at 15:05" / "3:05 PM"
  const m = errText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (/pm/i.test(m[3]) && h < 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
    const t = new Date();
    t.setHours(h, minute, 30, 0);
    let wait = t.getTime() - Date.now();
    if (wait < 0) wait += 24 * 3600_000;
    if (wait <= 24 * 3600_000) return wait;
  }
  // 解析 "in 45 minutes" / "in 2 hours"
  const m2 = errText.match(/in\s+(\d+)\s*(minute|hour)/i);
  if (m2) return parseInt(m2[1], 10) * (/hour/i.test(m2[2]) ? 3600_000 : 60_000) + 60_000;
  // 解析不出具体时间，默认 15 分钟后重试
  return 15 * 60_000;
}

/**
 * 生图主流程：内含掉线自动重登；触发限额时按 quotaWaitMs 算出的时长挂起等待，恢复后自动重试。
 * @param {object} page 页面实例
 * @param {string} prompt 提示词
 * @param {object} genOpts 透传给 generateOnPage 的生图参数
 * @param {number} timeoutMs 单次生图的超时毫秒数
 * @param {{ headless?: boolean, waitQuota?: boolean, maxWaitMs?: number }} [options] waitQuota 为 false 时遇限额直接报错；maxWaitMs 是允许等待的上限
 * @returns {Promise<string[]>} 本批图片的 src 列表
 */
async function generateWithQuotaWait(page, prompt, genOpts, timeoutMs, { headless = false, waitQuota = true, maxWaitMs = DEFAULT_QUOTA_MAX_WAIT_MS } = {}) {
  for (;;) {
    try {
      return await generateWithRelogin(page, prompt, genOpts, timeoutMs, { headless });
    } catch (e) {
      const waitMs = quotaWaitMs(String(e.message || e));
      if (!waitQuota || !waitMs || waitMs > maxWaitMs) throw e;
      console.error(`[限额] 触发使用上限，等待 ${Math.ceil(waitMs / 60000)} 分钟后自动重试...`);
      await new Promise((r) => setTimeout(r, waitMs + 5000));
    }
  }
}

// ---------- 参数处理 ----------

// OpenAI size 映射到 Flow 支持的宽高比（Flow 无 3:2 / 2:3，取最接近的 4:3 / 3:4）
function sizeToRatio(size) {
  return ({ '1024x1024': '1:1', '1536x1024': '4:3', '1024x1536': '3:4' }[String(size || '')] || null);
}

// 页面设置失败时的兜底：把宽高比写进提示词
function withAspectRatio(prompt, ratio) {
  if (!ratio || ratio === 'auto') return prompt;
  return `${prompt}\nAspect ratio: ${ratio}.`;
}

// ---------- 批量生图 ----------

/**
 * 把单个批量条目归一化：纯字符串就是提示词，对象则可带 n、ratio、model、res、timeout、wait 等覆盖项。
 * 只收集确实存在的键，方便调用方「defaults 在底、条目在上」合并。
 * @param {string|object} obj 原始条目
 * @returns {object|null} 归一化条目，无效输入返回 null
 */
function normalizeBatchEntry(obj) {
  if (typeof obj === 'string') return obj.trim() ? { prompt: obj.trim() } : null;
  if (!obj || typeof obj !== 'object' || typeof obj.prompt !== 'string' || !obj.prompt.trim()) return null;
  const e = { prompt: obj.prompt.trim() };
  if (obj.n !== undefined) e.n = Math.min(10, Math.max(1, Number(obj.n) || 1));
  if (obj.ratio || obj.aspect_ratio) e.ratio = obj.ratio || obj.aspect_ratio;
  if (obj.model) e.model = String(obj.model);
  if (obj.res || obj.download_size) e.res = obj.res || obj.download_size;
  if (obj.timeout !== undefined) e.timeout = Math.max(30, Number(obj.timeout) || 240);
  if (obj.wait !== undefined) e.wait = !!obj.wait;
  return e;
}

/**
 * 读取批量提示词文件，支持三种写法（可混用不会出错的情况已按优先级区分）：
 *   1. 纯文本：每行一个提示词，`#`、`//` 开头的行是注释，空行忽略；
 *   2. JSONL：每行一个 JSON 对象，如 {"prompt": "一只猫", "ratio": "16:9", "n": 2}；
 *   3. JSON 数组：整个文件是一个数组，元素同 JSONL。
 * @param {string} file 文件路径（相对当前目录）
 * @param {object} defaults 每个条目的默认值（来自 CLI / HTTP 的公共参数），条目内同名键优先
 * @returns {Array<object>} 合并后可直接执行的条目列表，空文件返回 []
 */
function parseBatchFile(file, defaults = {}) {
  if (!fs.existsSync(path.resolve(file))) die('文件不存在: ' + file);
  const text = fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, ''); // 去掉可能的 BOM
  const entries = [];
  const push = (it) => {
    const e = normalizeBatchEntry(it);
    if (e) entries.push({ ...defaults, ...e });
  };
  const whole = text.trim();
  if (whole.startsWith('[')) {
    let arr = null;
    try { arr = JSON.parse(whole); } catch { arr = null; }
    if (Array.isArray(arr)) { arr.forEach(push); return entries; }
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    if (s.startsWith('{')) {
      try { push(JSON.parse(s)); continue; } catch { /* 解析失败按普通提示词文本处理 */ }
    }
    push(s);
  }
  return entries;
}

/**
 * 执行一批生图条目（CLI 的 batch 与 HTTP 的 /batch 共用）。
 * parallel > 1 时用同一浏览器开多个标签页并行生成（共享登录态），同时提交互不阻塞；
 * 每个标签页走自己的输入框与 MutationObserver 监听，核验/取图逻辑天然互相独立。
 * 单条失败不中断整批，错误记进该条结果；进度打 stderr，便于调用方边跑边看。
 * @param {Array<object>} entries 归一化后的条目（prompt 必填，其余字段见 normalizeBatchEntry）
 * @param {object} page 第一个工作页面（并行时多开的标签页从 context 新建）
 * @param {object} context 浏览器上下文（一个配置文件只能开一个浏览器，并行靠多标签页）
 * @param {object} opts headless 是否无头；onItem 每完成一条回调一次；parallel 并行度 1~4
 * @returns {Promise<Array<object>>} 按 index 对齐的结果：ok、paths 或 error、elapsed_sec
 */
async function runBatch(entries, page, context, { headless = false, onItem = null, parallel = 1 } = {}) {
  const total = entries.length;
  const results = new Array(total);
  const totalGrabbed = { value: 0 };
  // 简单自旋分配的游标，同一事件循环内原子
  const grab = () => (totalGrabbed.value < total ? totalGrabbed.value++ : -1);

  async function processOne(i, myPage) {
    const e = entries[i];
    console.error(`[batch ${i + 1}/${total}] ${e.prompt.slice(0, 60)}`);
    const t1 = Date.now();
    const paths = [];
    const timeoutMs = Math.max(30, Number(e.timeout) || 240) * 1000;
    const n = Math.min(10, Math.max(1, Number(e.n) || 1));
    try {
      while (paths.length < n) {
        const want = Math.min(4, n - paths.length);
        const srcs = await generateWithQuotaWait(myPage, withAspectRatio(e.prompt, e.ratio || null), { want, ratio: e.ratio || null, model: e.model || null }, timeoutMs, { headless, waitQuota: !!e.wait });
        for (const src of srcs) {
          let imgPath = e.res ? await saveImageViaDownload(myPage, src, e.res, e.prompt, null) : null;
          if (!imgPath) imgPath = await saveImage(context, myPage, src, e.prompt, null);
          recordHistory(e.prompt, imgPath, Math.round((Date.now() - t1) / 1000));
          paths.push(imgPath);
        }
      }
      results[i] = { index: i, prompt: e.prompt.slice(0, 80), ok: true, count: paths.length, paths, elapsed_sec: Math.round((Date.now() - t1) / 1000) };
    } catch (err) {
      results[i] = { index: i, prompt: e.prompt.slice(0, 80), ok: false, error: String(err.message || err) };
    }
    console.error(`[batch ${i + 1}/${total}] ${results[i].ok ? '✓' : '✗'} ${results[i].ok ? results[i].count + ' 张，' : ''}${results[i].elapsed_sec ? Math.round((Date.now() - t1) / 1000) + ' 秒' : results[i].error?.slice(0, 60) || ''}`);
    if (onItem) onItem(results[i]);
  }

  const workers = Math.min(4, Math.max(1, parallel), total);
  if (workers <= 1) {
    let i;
    while ((i = grab()) >= 0) await processOne(i, page);
    return results;
  }

  console.error(`[batch] 并行 ${workers} 个标签页同时生成（Flow 侧并发满载时多出的条目会自动排队）`);
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const p = w === 0 ? page : await context.newPage();
    jobs.push((async () => {
      let i;
      while ((i = grab()) >= 0) await processOne(i, p);
      if (w > 0) await p.close().catch(() => {});
    })());
  }
  await Promise.all(jobs);
  return results;
}

// ---------- 子命令 ----------

// login：打开浏览器让人工登录 Google（含人机验证），回车后登录态保存进 .chrome-profile
async function cmdLogin() {
  console.log('即将打开浏览器，请在窗口中登录 Google 账号并进入 Google Flow（如出现人机验证也一并完成）。');
  console.log('能看到 Flow 界面和提示词输入框后，回到这里按回车保存并关闭。\n');
  const context = await launchContext({ headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await gotoWithRetry(page, DEFAULT_URL, { attempts: 4 });
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('完成登录后按回车...', () => { rl.close(); resolve(); });
  });
  const logged = await waitForComposer(page, 5000);
  console.log(logged ? '✓ 检测到输入框，登录态已保存。' : '⚠ 未检测到输入框。如果你在项目页之外，属正常；生成时报 NOT_LOGGED_IN 再重跑 login。');
  await context.close();
  if (!loadConfig().project_url) {
    console.log('\n下一步：在 Flow 中新建一个项目（例如命名为「生图」），打开项目后复制地址栏 URL，然后运行:');
    console.log('  node flowimg.js setproject "<项目URL>"   # 粘贴项目页地址');
    console.log('  node flowimg.js setproject              # 尝试自动从项目列表找到名为「生图」的项目');
  }
}

// 配置生图项目：所有生图都收进这个项目，不污染项目列表
async function cmdSetProject(flags) {
  const urlArg = flags._[0];
  if (urlArg) {
    if (!/^https:\/\/(labs\.google(\.com)?|flow\.google\.com)\//.test(urlArg)) die('URL 必须是 labs.google / flow.google.com 的链接（形如 .../tools/flow/project/<id> 或 flow.google.com/project/<id>）');
    saveConfig({ ...loadConfig(), project_url: urlArg.split('?')[0] });
    console.log(JSON.stringify({ ok: true, project_url: urlArg.split('?')[0] }));
    return;
  }
  console.log('未提供 URL，尝试从项目列表自动查找名为「生图」的项目...');
  const context = await launchContext({ headless: false });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await gotoWithRetry(page, DEFAULT_URL);
    await page.waitForTimeout(5000); // 等项目列表渲染
    const found = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/project/"], a[href*="tools/flow"]')];
      const hit = links.find((a) => a.href.includes('/project/') && (a.innerText || '').includes('生图'));
      return hit ? { href: hit.href, name: (hit.innerText || '').trim().slice(0, 50) } : null;
    });
    if (!found) {
      console.log('未找到名为「生图」的项目。请先在 Flow 网页里新建该项目，');
      console.log('打开项目页后复制地址栏 URL，再运行: node flowimg.js setproject "<项目URL>"');
      process.exitCode = 1;
      return;
    }
    const cfg = { ...loadConfig(), project_url: found.href.split('?')[0] };
    saveConfig(cfg);
    console.log(JSON.stringify({ ok: true, project_name: found.name, project_url: cfg.project_url }));
  } finally {
    await context.close().catch(() => {});
  }
}

// 为 serve 服务设置 API 密钥，写入 config.json
async function cmdSetApiKey(flags) {
  const key = flags._[0] || crypto.randomBytes(24).toString('hex');
  saveConfig({ ...loadConfig(), api_key: key });
  console.log(JSON.stringify({ ok: true, api_key: key, hint: '已保存到 config.json。调用时带请求头: Authorization: Bearer <key>' }, null, 2));
}

// 设置默认模型（此后 gen / serve 不带 --model 都使用它；名字必须与页面下拉里的选项一致）
async function cmdSetModel(flags) {
  const name = flags._[0];
  if (!name) die('缺少模型名。例: node flowimg.js setmodel "Nano Banana Pro"');
  saveConfig({ ...loadConfig(), default_model: name });
  console.log(JSON.stringify({ ok: true, default_model: name }));
}

function warnIfNoProject() {
  if (!loadConfig().project_url) {
    console.error('[提示] 未配置生图项目，生图会散落在自动新建的项目里。建议运行: node flowimg.js setproject');
  }
}

// gen：一次性生图命令，结果以 JSON 打 stdout，失败时退出码置 1
async function cmdGen(flags) {
  const prompt = flags._[0];
  if (!prompt) die('缺少提示词。用法: node flowimg.js gen "一只在月球上的猫" [--n 2] [--ratio 16:9] [--model "Nano Banana Pro"] [--res 2k] [--wait]');
  warnIfNoProject();
  const cfg = loadConfig();
  const timeoutMs = Math.max(30, Number(flags.timeout) || 240) * 1000;
  const n = Math.min(10, Math.max(1, Number(flags.n) || 1));
  const ratio = flags.ratio || null;
  const model = flags.model || cfg.default_model || null;
  const res = flags.res || null; // 详情页下载分辨率：1k / 2k / 4k
  const waitQuota = !!flags.wait;
  const t0 = Date.now();
  const context = await launchContext({ headless: !!flags.headless });
  try {
    const page = context.pages()[0] || (await context.newPage());
    const paths = [];
    while (paths.length < n) {
      const want = Math.min(4, n - paths.length); // Flow 单次最多 4 张
      const srcs = await generateWithQuotaWait(page, withAspectRatio(prompt, ratio), { want, ratio, model }, timeoutMs, { headless: !!flags.headless, waitQuota });
      for (const src of srcs) {
        let imgPath = res ? await saveImageViaDownload(page, src, res, prompt, (flags.out && n === 1) ? flags.out : null) : null;
        if (!imgPath) imgPath = await saveImage(context, page, src, prompt, (flags.out && n === 1) ? flags.out : null);
        recordHistory(prompt, imgPath, Math.round((Date.now() - t0) / 1000));
        paths.push(imgPath);
      }
    }
    console.log(JSON.stringify({ ok: true, paths, path: paths[0], elapsed_sec: Math.round((Date.now() - t0) / 1000) }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

// batch：按提示词文件批量生图（txt 每行一条、jsonl 每行一个 JSON、json 数组）
// 命令行选项作全批默认值，文件内条目的同名字段优先；单条失败不中断，最后退出码反映是否有失败项
async function cmdBatch(flags) {
  const file = flags._[0];
  if (!file) die('缺少提示词文件。用法: node flowimg.js batch prompts.txt [--n 2] [--ratio 16:9] [--wait]');
  warnIfNoProject();
  const defaults = {
    n: Math.min(10, Math.max(1, Number(flags.n) || 1)),
    ratio: flags.ratio || null,
    model: flags.model || loadConfig().default_model || null,
    res: flags.res || null,
    timeout: Math.max(30, Number(flags.timeout) || 240),
    wait: !!flags.wait,
  };
  const entries = parseBatchFile(file, defaults);
  if (!entries.length) die('文件里没有可用的提示词: ' + file);
  const parallel = Math.min(4, Math.max(1, Number(flags.parallel) || 1));
  console.error(`[batch] 共 ${entries.length} 条，复用同一浏览器${parallel > 1 ? `开 ${parallel} 个标签页并行` : '串行'}生成...`);
  const t0 = Date.now();
  const context = await launchContext({ headless: !!flags.headless });
  try {
    const page = context.pages()[0] || (await context.newPage());
    const results = await runBatch(entries, page, context, {
      headless: !!flags.headless,
      parallel,
      onItem: (r) => console.log(JSON.stringify(r)), // 每条完成一行 JSON，方便调用方实时消费（顺序按完成先后）
    });
    const succeeded = results.filter((r) => r.ok).length;
    console.error(`[batch] 完成：${succeeded}/${results.length} 成功`);
    console.log(JSON.stringify({ ok: succeeded > 0, total: results.length, succeeded, failed: results.length - succeeded, elapsed_sec: Math.round((Date.now() - t0) / 1000), results }));
    if (succeeded < results.length) process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * 常驻 HTTP 服务：长期复用同一个浏览器与页面，对外提供生图接口（含 OpenAI 兼容端点）、健康检查与图片静态访问。
 * 所有生图请求进串行队列，同一时间只跑一个提交，避免并发抢同一个页面；
 * 另有每 30 分钟的空闲保活刷新，降低人机验证与会话掉线的概率。
 * @param {object} flags port 监听端口，host 监听地址，headless 是否无头
 * @returns {Promise<void>} 服务常驻不返回，Ctrl+C 退出
 */
async function cmdServe(flags) {
  warnIfNoProject();
  const port = Number(flags.port) || DEFAULT_PORT;
  const host = flags.host || '127.0.0.1';
  const headless = !!flags.headless;
  const apiKey = process.env.FLOWIMG_API_KEY || loadConfig().api_key || null;
  if (!apiKey) console.error('[warn] 未配置 API Key，/generate 与 /v1 接口无鉴权（监听 127.0.0.1 时风险可控）。配置: node flowimg.js setapikey');

  let context = null;
  let page = null;
  const ensurePage = async () => {
    if (page && !page.isClosed()) return;
    if (!context) context = await launchContext({ headless });
    try {
      page = context.pages()[0] || (await context.newPage());
    } catch {
      // 整个浏览器进程已退出（如窗口被关闭），自动重启
      context = await launchContext({ headless });
      page = context.pages()[0] || (await context.newPage());
    }
  };
  await ensurePage();

  // 串行队列：同一时间只跑一个提交
  let queue = Promise.resolve();

  // 空闲保活：每 30 分钟刷新一次页面，降低人机验证与会话掉线的概率
  setInterval(() => {
    queue = queue.then(async () => {
      try {
        if (page && !page.isClosed() && !page.url().startsWith('chrome://')) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
      } catch { /* 忽略保活失败 */ }
    });
  }, 30 * 60 * 1000).unref();

  const readBody = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });

  const authed = (req) => {
    if (!apiKey) return true;
    return (req.headers.authorization || '') === `Bearer ${apiKey}`;
  };

  const server = http.createServer(async (req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;

    // 图片静态访问：GET /output/<文件名>
    if (req.method === 'GET' && p.startsWith('/output/')) {
      const base = path.basename(decodeURIComponent(p.slice('/output/'.length)));
      const file = path.join(OUTPUT_DIR, base);
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      const type = types[path.extname(base).toLowerCase()];
      if (!type || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && p === '/health') {
      let caps = null;
      if (page && !page.isClosed() && /labs\.google|flow\.google\.com/.test(page.url())) {
        try { caps = await probeCapabilities(page); } catch { /* 页面可能在跳转中 */ }
      }
      return send({
        ok: true, version: VERSION, driver: DRIVER,
        page_alive: !!(page && !page.isClosed()),
        page_url: page && !page.isClosed() ? page.url() : null,
        capabilities: caps,
        project_configured: !!loadConfig().project_url,
        api_key_enabled: !!apiKey,
      });
    }
    if (req.method === 'GET' && p === '/quota') {
      return send({ ok: true, last_3h: countRecent(3).used });
    }

    // 排障：当前页面状态与截图，受 API 密钥保护
    if (req.method === 'GET' && p === '/debug/pageinfo') {
      if (!authed(req)) return send({ ok: false, error_kind: 'auth', error: '未授权' }, 401);
      const info = { ok: true, url: page && !page.isClosed() ? page.url() : null };
      if (page && !page.isClosed()) {
        info.title = await page.title().catch(() => null);
        info.capabilities = await probeCapabilities(page).catch(() => null);
        const dir = path.join(OUTPUT_DIR, 'debug');
        fs.mkdirSync(dir, { recursive: true });
        info.screenshot = path.join(dir, `page_${Date.now()}.png`);
        await page.screenshot({ path: info.screenshot }).catch(() => { info.screenshot = null; });
      }
      return send(info);
    }

    // 批量生图：POST /batch；prompts 数组混合字符串与对象均可，公共选项在顶层、条目内同名字段优先
    if (req.method === 'POST' && p === '/batch') {
      if (!authed(req)) return send({ ok: false, error_kind: 'auth', error: '未授权：需要请求头 Authorization: Bearer <api-key>' }, 401);
      let payload;
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { return send({ ok: false, error: '请求体必须是 JSON' }, 400); }
      const rawItems = Array.isArray(payload.prompts) ? payload.prompts : (Array.isArray(payload.items) ? payload.items : []);
      const defaults = {
        n: Math.min(10, Math.max(1, Number(payload.n) || 1)),
        ratio: payload.aspect_ratio || sizeToRatio(payload.size) || null,
        model: (payload.model && payload.model !== 'google-flow' ? payload.model : null) || loadConfig().default_model || null,
        res: payload.res || payload.download_size || null,
        timeout: Math.max(30, Number(payload.timeout) || 240),
        wait: payload.wait !== false,
      };
      const entries = rawItems.map((it) => normalizeBatchEntry(it)).filter(Boolean).map((e) => ({ ...defaults, ...e })).slice(0, 50);
      if (!entries.length) return send({ ok: false, error: 'prompts 数组必须至少包含一个提示词（字符串，或 {"prompt":"..."} 对象），上限 50 条' }, 400);
      const t0 = Date.now();
      const parallel = Math.min(4, Math.max(1, Number(payload.parallel) || 1));
      queue = queue.then(async () => {
        try {
          await ensurePage();
          const results = await runBatch(entries, page, context, { headless, parallel });
          const succeeded = results.filter((r) => r.ok).length;
          send({ ok: succeeded > 0, total: results.length, succeeded, failed: results.length - succeeded, elapsed_sec: Math.round((Date.now() - t0) / 1000), results });
        } catch (e) {
          send({ ok: false, error_kind: 'error', error: String(e.message || e) }, 500);
        }
      });
      return;
    }

    const isGen = req.method === 'POST' && (p === '/generate' || p === '/v1/images/generations');
    if (!isGen) return send({ ok: false, error: 'not found' }, 404);
    if (!authed(req)) return send({ ok: false, error_kind: 'auth', should_retry: false, error: '未授权：需要请求头 Authorization: Bearer <api-key>' }, 401);

    const openai = p.startsWith('/v1/');
    let payload;
    try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { return send({ ok: false, error: '请求体必须是 JSON' }, 400); }
    const prompt = String(payload.prompt || '').trim();
    if (!prompt) return send({ ok: false, error: '缺少 prompt' }, 400);
    const timeoutMs = Math.max(30, Number(payload.timeout) || 240) * 1000;
    const n = Math.min(10, Math.max(1, Number(payload.n) || 1));
    const ratio = payload.aspect_ratio || sizeToRatio(payload.size) || null;
    const model = (payload.model && payload.model !== 'google-flow' ? payload.model : null) || loadConfig().default_model || null;
    const downloadRes = payload.res || payload.download_size || null;
    const waitQuota = payload.wait !== false; // 默认排队等待限额恢复
    const responseFormat = payload.response_format === 'b64_json' ? 'b64_json' : 'url';

    queue = queue.then(async () => {
      const t0 = Date.now();
      try {
        await ensurePage();
        const paths = [];
        while (paths.length < n) {
          const want = Math.min(4, n - paths.length);
          const srcs = await generateWithQuotaWait(page, withAspectRatio(prompt, ratio), { want, ratio, model }, timeoutMs, { headless, waitQuota });
          for (const src of srcs) {
            let imgPath = downloadRes ? await saveImageViaDownload(page, src, downloadRes, prompt, (payload.out && n === 1) ? payload.out : null) : null;
            if (!imgPath) imgPath = await saveImage(context, page, src, prompt, (payload.out && n === 1) ? payload.out : null);
            recordHistory(prompt, imgPath, Math.round((Date.now() - t0) / 1000));
            paths.push(imgPath);
          }
        }
        const elapsed = Math.round((Date.now() - t0) / 1000);
        if (openai) {
          const data = await Promise.all(paths.map(async (ip) => responseFormat === 'b64_json'
            ? { b64_json: (await fs.promises.readFile(ip)).toString('base64') }
            : { url: `http://${host}:${port}/output/${encodeURIComponent(path.basename(ip))}`, local_path: ip }));
          return send({ created: Math.floor(Date.now() / 1000), data });
        }
        send({ ok: true, paths, path: paths[0], elapsed_sec: elapsed });
      } catch (e) {
        const msg = String(e.message || e);
        const qms = quotaWaitMs(msg);
        if (qms) {
          const retryAfter = Math.ceil(qms / 1000);
          if (openai) return send({ error: { message: msg, type: 'rate_limit_error', code: 'rate_limit_exceeded', retry_after: retryAfter } }, 429);
          return send({ ok: false, error_kind: 'rate_limit', should_retry: true, retry_after: retryAfter, error: msg }, 429);
        }
        if (openai) return send({ error: { message: msg, type: 'server_error' } }, 500);
        send({ ok: false, error_kind: 'error', should_retry: false, error: msg }, 500);
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`生图服务已启动: http://${host}:${port}（driver: ${DRIVER}${apiKey ? '，已启用 API Key' : ''}）`);
    console.log('  POST /generate                {"prompt":"...","n":2,"aspect_ratio":"16:9","wait":true}');
    console.log('  POST /batch                   {"prompts":["...","..."],"aspect_ratio":"16:9"}  批量生图');
    console.log('  POST /v1/images/generations   OpenAI 兼容（prompt / size / n / response_format）');
    console.log('  GET  /output/<文件>  图片访问    GET /health  /quota');
    console.log('浏览器窗口请保持打开，Ctrl+C 退出服务。');
  });
}

// quota：输出最近 3 小时通过本程序生成的图片数量
function cmdQuota() {
  const { used, since } = countRecent(3);
  console.log(JSON.stringify({ ok: true, used_last_3h: used, since }, null, 2));
}

/**
 * 打开当前项目页，把可见的交互元素结构转储到 output/debug/probe.json，并附一张整页截图。
 * 用于页面改版后的选择器适配；各旗帜负责在转储前先把对应菜单、下拉、卡片点开。
 * @param {object} flags opensettings 开设置 chip，openmodel 开模型下拉，pickmodel 选中指定模型，opencard 点开大图卡片，opendownload 配合 opencard 再开下载菜单
 * @returns {Promise<void>} 结果写入 output/debug/，摘要打 stdout
 */
async function cmdProbe(flags = {}) {
  const context = await launchContext({ headless: false });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await gotoWithRetry(page, entryUrl());
    await page.waitForTimeout(6000); // 等前端完全水合
    // 先清掉 Cookie 弹窗，别让它遮住交互
    await dismissOverlays(page).catch(() => {});
    if (flags.opensettings) {
      const chip = page.locator('button[aria-label="设置触发器"], button:has(i:text-matches("^crop_", ""))').first();
      if (await chip.count()) { await chip.click().catch(() => {}); await page.waitForTimeout(1500); }
      else console.error('[warn] 未找到设置 chip');
    }
    if (flags.openmodel) {
      // 先开设置面板，再开模型下拉，转储菜单项
      const chip = page.locator(SETTINGS_CHIP_SEL).first();
      if (await chip.count()) { await chip.click().catch(() => {}); await page.waitForTimeout(800); }
      const trig = page.locator(MODEL_TRIGGER_SEL).first();
      if (await trig.count()) { await trig.click().catch(() => {}); await page.waitForTimeout(1200); }
      else console.error('[warn] 未找到模型下拉');
    }
    if (flags.pickmodel) {
      // 在已打开的模型菜单中选指定模型，然后再转储（看选 Pro 后面板多了什么选项）
      const label = String(flags.pickmodel);
      const item = page.locator(`[role='menuitem']:has-text("${label}")`).first();
      if (await item.count()) await item.click().catch(() => {});
      else await clickModelMenuItem(page, label); // 菜单没开就自己开
      await page.waitForTimeout(1200);
    }
    if (flags.opencard) {
      await page.evaluate(() => {
        const big = [...document.querySelectorAll('img')].filter((i) => Math.max(i.naturalWidth, i.width) >= 200)[0];
        if (big) big.click();
      });
      await page.waitForTimeout(2000);
      if (flags.opendownload) {
        const dl = page.locator('button[aria-label*="下载媒体内容"], button[aria-label*="Download" i]').first();
        if (await dl.count()) { await dl.click().catch(() => {}); await page.waitForTimeout(1200); }
        else console.error('[warn] 详情页未见下载按钮');
      }
    }
    const dump = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight);
      const info = (el) => ({
        tag: el.tagName.toLowerCase(),
        text: clean(el.innerText),
        aria_label: el.getAttribute('aria-label'),
        aria_haspopup: el.getAttribute('aria-haspopup'),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        disabled: el.disabled ?? el.getAttribute('aria-disabled'),
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      });
      return {
        url: location.href,
        title: document.title,
        buttons: [...document.querySelectorAll('button')].filter(vis).map(info),
        menus: [...document.querySelectorAll('[aria-haspopup="menu"]')].filter(vis).map(info),
        chips: [...document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [role="button"]')].filter(vis).map(info),
        editors: [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')].map(info),
        tabs: [...document.querySelectorAll('[role="tab"]')].filter(vis).map(info),
        menu_items: [...document.querySelectorAll('[role="menuitem"], [role="option"], mat-option, [role="listbox"] *')].filter(vis).map(info),
        big_imgs: [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 200 || i.width >= 200).map((i) => ({
          src_host: (i.currentSrc || i.src || '').slice(0, 120),
          alt: i.alt, w: i.naturalWidth, h: i.naturalHeight,
        })).slice(0, 30),
        // 网格卡片：每张生成结果在页面上的完整呈现（卡片文案里通常带有提示词 / 时间 / 进度）
        cards: [...document.querySelectorAll('img, video')].filter((i) => (i.naturalWidth || i.videoWidth || i.width) >= 200).map((media) => {
          const card = media.closest('[role="listitem"], [role="gridcell"], article, li, [class*="card" i]') || media.parentElement;
          return {
            media_tag: media.tagName.toLowerCase(),
            src_head: (media.currentSrc || media.src || '').slice(0, 80),
            card_tag: card ? card.tagName.toLowerCase() : null,
            card_role: card ? card.getAttribute('role') : null,
            card_text: clean(card ? card.innerText : '').slice(0, 200),
            card_links: card ? [...card.querySelectorAll('a')].map((a) => a.href.slice(0, 120)).slice(0, 3) : [],
            card_btns: card ? [...card.querySelectorAll('button')].map((b) => clean(b.innerText || b.getAttribute('aria-label'))).slice(0, 5) : [],
          };
        }).slice(0, 20),
        videos: [...document.querySelectorAll('video')].map((v) => ({ src: (v.currentSrc || '').slice(0, 120) })),
      };
    });
    const dir = path.join(OUTPUT_DIR, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'probe.json');
    fs.writeFileSync(file, JSON.stringify(dump, null, 2));
    await page.screenshot({ path: path.join(dir, 'probe.png') });
    console.log(JSON.stringify({ ok: true, probe: file, buttons: dump.buttons.length, editors: dump.editors.length, menus: dump.menus.length, menu_items: dump.menu_items.length, tabs: dump.tabs.length }));
  } finally {
    await context.close().catch(() => {});
  }
}

// doctor：自检并打印 Node 版本、驱动、配置项、浏览器通道与 serve 存活状态
async function cmdDoctor() {
  const out = { ok: true, checks: {} };
  out.checks.node = process.version;
  out.checks.driver = DRIVER;
  out.checks.version = VERSION;
  out.checks.profile_dir = fs.existsSync(PROFILE_DIR) ? 'exists' : 'missing (还未 login)';
  out.checks.output_dir = OUTPUT_DIR;
  out.checks.project_url = loadConfig().project_url || '未配置（生图会散落在新项目里，建议运行 node flowimg.js setproject）';
  try {
    const context = await launchContext({ headless: false });
    await context.close(); // 只验证浏览器通道能起来；登录检查交给 login / gen（避免白等页面打开）
    out.checks.browser = 'ok';
  } catch (e) {
    out.ok = false;
    out.checks.browser = String(e.message || e);
  }
  try {
    const r = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    out.checks.serve = r.ok ? 'running' : 'not running';
  } catch { out.checks.serve = 'not running'; }
  console.log(JSON.stringify(out, null, 2));
}

// ---------- 入口 ----------

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
const flags = { _: [] };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
    else flags[key] = true;
  } else flags._.push(a);
}

const commands = {
  login: () => cmdLogin(),
  setproject: () => cmdSetProject(flags),
  setapikey: () => cmdSetApiKey(flags),
  setmodel: () => cmdSetModel(flags),
  gen: () => cmdGen(flags),
  batch: () => cmdBatch(flags),
  serve: () => cmdServe(flags),
  quota: () => cmdQuota(),
  probe: () => cmdProbe(flags),
  doctor: () => cmdDoctor(),
};

if (!commands[cmd]) {
  console.log('用法: node flowimg.js <login|setproject|setapikey|setmodel|gen|batch|serve|quota|doctor|probe> [选项]');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
