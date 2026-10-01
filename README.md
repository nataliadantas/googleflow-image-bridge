# Google Flow 网页版生图桥（google-flow-image-bridge）

让本地 Agent 调用你已登录的网页版 Google Flow 账号生成图片，无需付费 API。

> A bridge that lets local agents generate images through your logged-in Google Flow web account (Nano Banana / Imagen). It drives real Chrome with patchright, and exposes a CLI, an OpenAI-compatible HTTP API, and an MCP server. 同系列的 ChatGPT 网页版方案见 gpt-web-image-bridge。

## 简介

很多开发者的主力工具是本地 Agent，但图片生成额度在网页版 Google Flow 账号里。本项目在两者之间搭桥：用 patchright（反检测补丁版 Playwright）驱动真实 Chrome 操作网页，把生图能力包装成本地接口。

核心特性：

- 提供三种调用方式：命令行、HTTP 常驻服务和 MCP 工具。
- 提供 OpenAI 兼容接口，任何 OpenAI 软件开发工具包（SDK）都可直接接入。
- 参数全可控：图片模式、宽高比、数量、模型和下载分辨率，都能在页面上自动点选。
- 限额感知：自动解析恢复时间，排队等待重试，或返回 `retry_after` 供调用方决策。
- 稳定自愈：掉线时弹窗等待人工重登并自动续跑，空闲时自动保活，残留浏览器进程自动清理。
- 防混图：项目网格会陈列所有历史图片。程序只收取本次提示词生成的图片，手动生成的错图会被拒收。

## 快速上手

依次执行以下四条命令，即可完成首次配置并生成第一张图片：

```bash
npm install
node flowimg.js login       # 打开 Chrome 登录 Google 并进入 Flow，回终端按 Enter 保存会话
node flowimg.js setproject "项目URL"   # 粘贴 Flow 项目页面地址（需先在网页中新建项目）
node flowimg.js gen "一只在月球表面弹吉他的猫，电影感"
```

成功后输出 JSON 结果，其中 `path` 字段是图片的本地路径：

```json
{"ok":true,"paths":["D:\\googleflowcli\\output\\xxx.jpg"],"path":"D:\\googleflowcli\\output\\xxx.jpg","elapsed_sec":45}
```

## 入门篇

### 安装与环境

运行本程序需要以下条件：

- Node.js 18 及以上版本。
- 本机已安装 Google Chrome。未安装时回退到 Playwright 自带的 Chromium。
- 可正常访问 labs.google、flow.google.com 的网络环境。
- 一个可以使用 Google Flow 的 Google 账号。AI Pro、Ultra 订阅有不同的生图额度。

执行 `npm install` 安装依赖。依赖包含 patchright、playwright 和 MCP SDK，首次使用浏览器回退功能时需另行执行 `npx playwright install chromium`。

### 首次配置

**（1）登录账号**

执行 `node flowimg.js login` 后会弹出 Chrome 窗口。在窗口中登录 Google 账号并进入 Google Flow，完成可能出现的人机验证。看到 Flow 界面和提示词输入框后，回到终端按 Enter，登录态会保存到 `.chrome-profile/` 目录。

**（2）配置生图项目**

Flow 的生图都发生在项目内。先在 Flow 网页中新建一个名为“生图”的项目，打开项目页复制地址栏 URL（形如 `https://labs.google/fx/tools/flow/project/<id>` 或 `https://flow.google.com/project/<id>`），再执行 `node flowimg.js setproject "项目URL"` 写入 `config.json`。也可以直接执行 `node flowimg.js setproject`，程序会尝试从项目列表自动找到该名称的项目。

**（3）设置默认模型（可选）**

执行 `node flowimg.js setmodel "Nano Banana Pro"`，以后调用不再带 `--model` 也会使用该模型。可选值以页面模型下拉为准，目前有 Nano Banana Pro、Nano Banana 2 和 Nano Banana 2 Lite。

**（4）设置访问密钥（可选）**

常驻服务默认不带鉴权。仅在监听地址不是 127.0.0.1 时必须设置 API 密钥。执行 `node flowimg.js setapikey` 会生成随机密钥并写入 `config.json`。

**（5）验证**

执行 `node flowimg.js doctor`，确认浏览器驱动正常。

### 基本用法

最常用的方式是命令行直接调用，任何 Agent 都可以通过执行命令使用：

```bash
node flowimg.js gen "提示词"                              # 生成一张图片
node flowimg.js gen "提示词" --n 4 --ratio 16:9 --wait    # 一次 4 张横图，限额时自动排队
node flowimg.js gen "提示词" --model "Nano Banana 2"      # 临时切换模型
node flowimg.js gen "提示词" --res 2k                     # 经详情页下载 2K 原图（约 2400px）
node flowimg.js batch prompts.txt --wait                  # 按文件批量生图
node flowimg.js quota                                     # 查看最近 3 小时通过本程序生成的数量
```

命令行每次调用都要启动一次浏览器，耗时增加 10~20 秒，且窗口会短暂出现。高频使用建议改用常驻服务模式。

## 进阶篇

### 批量生图

`batch` 命令按提示词文件批量生成，全程复用同一个浏览器，单条失败不中断整批。支持三种文件格式，可以按需挑选：

```
# prompts.txt：纯文本，每行一个提示词（#、// 开头的行是注释）
一只在月球上弹吉他的猫
赛博朋克风格的重庆夜景

# prompts.jsonl：每行一个 JSON 对象，可带覆盖项
{"prompt": "一只在月球上弹吉他的猫", "ratio": "16:9", "n": 2}
{"prompt": "赛博朋克风格的重庆夜景", "model": "Nano Banana 2", "res": "2k"}

# prompts.json：整个文件是 JSON 数组，元素同 JSONL
["一只在月球上弹吉他的猫", {"prompt": "重庆夜景", "ratio": "16:9"}]
```

优先级规则：文件内条目的字段（`n`、`ratio`、`model`、`res`、`timeout`、`wait`）优先，其次看命令行同名选项，最后是 `setmodel` 配置的默认模型。每条完成后在 stdout 输出一行 JSON，末尾有汇总，便于调用方实时消费结果。

**并行生图**：加 `--parallel N`（1~4）可在同一个浏览器里开 N 个标签页同时生成，共享登录态，互不干扰。

```bash
node flowimg.js batch prompts.txt --parallel 3 --wait
```

- 并行只是客户端并发，Flow 账号本身有服务端并发上限，超出后多余任务会在 Google 侧排队，总时长不会继续缩短。
- 并行度越大越容易触发人机验证和限额，日常使用建议 2~3，密集自动化不要超过 3。
- Flow 高负载时页面上会有提示横幅，生成会明显变慢甚至排队失败，此时把 `--timeout` 调大（例如 360 或更大），或错峰重试，Cloud 侧退款失败的积分为自动退返。

HTTP 侧对应 `POST /batch`：`prompts` 是数组（字符串或对象混用均可，上限 50 条），顶层参数作全批默认值，`parallel` 传入 1~4。MCP 侧对应 `generate_images` 工具，并行仅在常驻服务运行时生效（一次性 CLI 无法并行，会抢配置文件锁）。

### 常驻 HTTP 服务

执行 `node flowimg.js serve` 启动常驻服务，默认监听 `127.0.0.1:3888`。浏览器保持打开，每个请求复用同一页面，响应速度最快。

设置了密钥后，生图类接口需要携带请求头 `Authorization: Bearer <密钥>`。健康检查和图片访问保持公开。密钥也可通过环境变量 `FLOWIMG_API_KEY` 提供。

### OpenAI 兼容接口

服务提供 OpenAI 官方协议的生图接口 `POST /v1/images/generations`。支持 OpenAI SDK 的任何工具都可以直接接入，无需了解本项目的私有协议。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3888/v1", api_key="你的密钥")
result = client.images.generate(
    prompt="赛博朋克风格的重庆夜景",
    size="1024x1024",
    n=1,
)
print(result.data[0].url)  # 可直接访问的图片地址
```

Flow 页面支持的宽高比为 `16:9`、`9:16`、`4:3`、`3:4` 和 `1:1`（没有 3:2、2:3）。`size` 字段的映射是：`1024x1024` → `1:1`、`1536x1024` → `4:3`、`1024x1536` → `3:4`。原生接口可直接传 `aspect_ratio`。

### 分辨率与模型

生成时模型在设置面板中选，分辨率的“尺寸”选项不在生成面板，而在图片详情页的“下载媒体内容”菜单里。

- 下载菜单分三档：`1K 原始尺寸`、`2K 已高清重塑`、`4K 已高清重塑`。
- 传 `res` 参数后，程序自动进入详情页点选对应档位，通过真实浏览器下载拿到原始文件。高档位未订阅时自动降档，全程失败则回退普通取图。
- 不传 `res` 时走快速通道：页面内 fetch 直接抓预览图，每张约 1024~1376px，速度快十几秒。
- 4K 是 Ultra 订阅的档位，PRO 账号不可用。

模型与额度有关：Nano Banana Pro 单张消耗的积分明显高于 Nano Banana 2，日常草图可用 `--model "Nano Banana 2"` 临时切回。

### MCP 接入

MCP 适合支持工具调用的 Agent（Codex、Claude 等）。在 Agent 的 MCP 配置中加入：

```toml
[mcp_servers.google-flow-image]
command = "node"
args = ["D:\\googleflowcli\\mcp-server.js"]
```

重启 Agent 后即可自然语言调用，例如“用 Flow 生成一张猫咪的图片”。MCP 优先走已启动的常驻服务，服务未启动时自动退化为一次性命令行调用。为服务设置了密钥时，需要同步设置环境变量 `FLOWIMG_API_KEY`。

### 限额与稳定性

Flow 的图片额度按账号订阅等级发放，以页面提示为准。触发限额时，常驻服务默认（`wait: true`）排队等待恢复后自动继续；设为 `wait: false` 时立即返回 HTTP 429，并附带 `retry_after` 秒数。

登录态会定期失效，属于正常现象。生图途中掉线时，程序会把浏览器窗口顶到最前方。你在 5 分钟内重新登录或完成人机验证后，程序自动继续刚才的任务，调用方无感知。常驻服务每 30 分钟自动刷新页面保活，掉线频率明显低于每次冷启动的命令行模式。

### 结果是如何防混图的

Flow 的项目页会把所有历史图片列成网格，你在网页里手动生成的图片也会实时同步进来。图片地址是每次渲染都会变化的签名 URL，无法用全局快照做差集。程序用两层机制保证只收取本批结果：

1. MutationObserver 只跟踪“提交后新挂载到 DOM 的图片节点”，历史图片的节点原地不动，不会上榜。
2. 对每个候选节点，点它卡片的“重复使用提示”按钮把原始提示词回填进输入框，与本批提示词比对。不一致的图直接拒收；核验机制失效时降级为按出现顺序取图并告警。

## API 参考

### HTTP 接口

常驻服务提供的全部接口如下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/generate` | 原生生图接口 |
| POST | `/batch` | 批量生图接口 |
| POST | `/v1/images/generations` | OpenAI 兼容生图接口 |
| GET | `/output/<文件名>` | 访问已生成的图片 |
| GET | `/health` | 服务状态、浏览器驱动与选择器能力探测 |
| GET | `/quota` | 最近 3 小时通过本程序生成的数量 |
| GET | `/debug/pageinfo` | 排障用页面状态与截图，需要密钥 |

`POST /generate` 的请求体参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 必填 | 图片提示词，中英文均可 |
| `n` | number | 1 | 数量，范围 1~10；Flow 单次最多 4 张，超过自动分批串行 |
| `aspect_ratio` | string | 无 | `16:9`、`9:16`、`4:3`、`3:4`、`1:1` |
| `model` | string | 配置的默认模型 | 页面模型菜单里的选项名，如 `Nano Banana Pro` |
| `res` | string | 无 | 下载分辨率 `1k`、`2k`、`4k`，经详情页拿原始文件；高档位未订阅时自动降档 |
| `timeout` | number | 240 | 单次提交的超时秒数 |
| `wait` | boolean | true | 限额时是否排队等待恢复 |

`POST /batch` 的请求体：`prompts` 数组（上限 50 条），元素是字符串，或带 `n`、`ratio`、`model`、`res`、`timeout`、`wait` 覆盖项的对象；顶层同名参数作全批默认值；`parallel`（1~4，默认 1）控制同浏览器标签页并行数。响应含 `total`、`succeeded`、`failed` 和每项 `results`。

### CLI 命令

| 命令 | 作用 |
| --- | --- |
| `login` | 打开浏览器登录 Google，保存会话 |
| `setproject` | 配置生图项目地址（参数可省略，自动找名为“生图”的项目） |
| `setapikey` | 设置服务密钥，缺省时自动生成随机值 |
| `setmodel` | 设置默认模型，例如 `node flowimg.js setmodel "Nano Banana Pro"` |
| `gen` | 生成图片 |
| `batch` | 按提示词文件批量生图（txt、jsonl、json 数组三种格式），单条失败不中断；`--parallel N` 可并行 1~4 个标签页 |
| `serve` | 启动常驻 HTTP 服务 |
| `quota` | 查看最近 3 小时通过本程序生成的数量 |
| `doctor` | 检查浏览器驱动与服务状态 |
| `probe` | 转储页面 DOM 结构到 `output/debug/probe.json`，供页面改版后适配选择器 |

`gen` 命令支持的选项如下：

| 选项 | 说明 |
| --- | --- |
| `--n` | 数量，范围 1~10 |
| `--ratio` | 宽高比：`16:9`、`9:16`、`4:3`、`3:4`、`1:1` |
| `--model` | 模型选项名，例如 `"Nano Banana Pro"`；缺省用 `setmodel` 设置的默认模型 |
| `--res` | 下载分辨率 `1k`、`2k`、`4k`，详情页取原始文件；缺省为快速 fetch |
| `--timeout` | 超时秒数，默认 240 |
| `--wait` | 触发限额时排队等待恢复 |
| `--out` | 输出文件名，仅 `n` 为 1 时生效 |
| `--headless` | 尝试无头模式 |

`probe` 命令支持的旗帜如下：

| 旗帜 | 说明 |
| --- | --- |
| `--opensettings` | 先点开输入框旁的设置面板，再转储 |
| `--openmodel` | 再点开模型下拉，转储菜单项 |
| `--pickmodel "名称"` | 在已打开的模型菜单中选指定模型，再转储（用于观察面板变化） |
| `--opencard` | 点开第一张卡片详情，再转储 |
| `--opendownload` | 详情页里再点开下载菜单（与 `--opencard` 连用） |

### MCP 工具

| 工具 | 作用 |
| --- | --- |
| `generate_image(prompt, aspect_ratio?, model?, download_size?, timeout_sec?)` | 生成图片，返回本地绝对路径 |
| `generate_images(prompts, aspect_ratio?, model?, download_size?, timeout_sec?, parallel?)` | 批量生图（上限 50 条），每项返回 ok、paths 或 error；parallel 仅在常驻服务生效 |
| `quota_info()` | 查询最近 3 小时的已用数量 |

## FAQ

**问：生图会把我的 Flow 项目列表弄乱吗？**

答：不会。所有生图都发生在配置的“生图”项目内部，只多这一个项目。

**问：提示 NOT_LOGGED_IN 怎么办？**

答：等待程序弹出的浏览器窗口，在窗口中重新登录 Google 账号或完成人机验证即可。5 分钟内程序自动续跑，调用方无感知。也可以提前执行 `node flowimg.js login` 手动完成。

**问：我一边用软件生图，一边自己在网页里手动点会怎样？**

答：可以，互不干扰。项目网格会实时同步双方生成的图片，程序靠“重复使用提示”核验每张候选图的提示词原文，不是你这次提示词的图不会收。

**问：生成失败，哪里看现场？**

答：请求 `GET /debug/pageinfo`（需要密钥），返回当前页面地址、选择器能力探测结果，并在 `output/debug/` 保存页面截图。也可以执行 `node flowimg.js probe --opensettings` 转储完整的按钮与菜单结构。

**问：页面提示 unusual activity 怎么办？**

答：这是 Google 的机器人判定。本程序已做反检测处理（patchright 驱动、逐字模拟输入），仍触发时刷新页面后重试即可。常驻服务模式会定期保活刷新，触发频率低很多。

**问：quota 命令查出来的数量准确吗？**

答：那仅统计通过本程序生成的本地历史记录。Flow 官方额度以页面提示为准，网页里手动生成的不会计入。

**问：配置文件里有哪些敏感信息？**

答：`config.json` 存有项目地址、默认模型和服务密钥，`.chrome-profile/` 存有登录 Cookie，两者均已加入 `.gitignore`。请勿将它们分享给他人。

## 附录

### 文件结构

```
flowimg.js          主程序，提供 login、setproject、setapikey、setmodel、gen、serve、quota、doctor、probe 命令
mcp-server.js       MCP 封装，提供 generate_image、quota_info 工具
config.json         项目地址、默认模型与服务密钥，由命令自动生成，已加入 .gitignore
config.example.json 配置文件模板
output/             生成的图片、history.jsonl 记录和 debug/ 排障截图
.chrome-profile/    Chrome 登录会话，已加入 .gitignore
```

### 页面结构说明

以下细节来自实际账号实测（2026-10，flow.google.com 新界面）与公开调研（labs.google 旧界面，参考 gflow-cli），供日后页面改版时排障。

| 事项 | 旧界面（labs.google） | 新界面（flow.google.com） |
| --- | --- | --- |
| 生图入口 | `labs.google/fx/tools/flow/project/<id>` | `flow.google.com/project/<id>` |
| 设置面板 | 带 `crop_*` 图标的菜单，内含 Image/Video、宽高比和数量的 tab | 输入框旁的“设置触发器” chip，点开是 radio 面板 |
| 模型下拉 | 画布区域的模型菜单 | 设置面板内的“选择模型系列”下拉 |
| 结果图片地址 | `lh3.googleusercontent.com` | 同源签名地址 `flow.google.com/asb/<token>`（每次渲染会变） |
| 图片 alt | `Generated image` | “显示用户图片的图块” |
| 下载分辨率 | 详情页下载菜单 | 详情页“下载媒体内容”菜单：`1K`、`2K`、`4K` |

Google 会把账号在两个前端之间迁来迁去，程序对两个界面都做了适配。

其他注意事项：

- 提示词输入框是 Slate、ProseMirror 富文本（`div[role="textbox"]`），不是 textarea。页面常驻一个隐藏的 `#g-recaptcha-response` 验证码 textarea，选择器必须排除它并只点可见元素。
- Cookie 弹窗会罩住提交按钮，导致点击被静默拦截。进入项目后必须先清掉弹窗。
- 提交以“输入框被清空”为成功判据，浮层拦截的点击不算数。
- 每张卡片详情页地址形如 `.../project/<pid>/edit/<image_id>`，提示词直接显示在页面上。

### 更新日志

- `v0.4.0`：新增批量生图，支持并行——CLI `batch` 命令（txt、jsonl、json 数组三种提示词文件格式，`--parallel 1~4` 在同一浏览器多标签页并行）、HTTP `POST /batch` 接口和 MCP `generate_images` 工具；单条失败不中断，条目级参数可覆盖全批默认值
- `v0.3.0`：新增默认模型配置（`setmodel`）、详情页下载分辨率控制（`--res`，支持 1K、2K、4K 自动降档）；修复 serve 与 HTTP 响应对象命名的冲突
- `v0.2.0`：适配 flow.google.com 新界面（设置 chip、radio 面板）；结果识别改为 MutationObserver +“重复使用提示”双保险；新增 `probe` 排障命令；修复 Cookie 弹窗拦截点击、隐藏验证码 textarea 误选中、同秒文件名互相覆盖的问题
- `v0.1.0`：首个可用版本，面向 labs.google 旧界面，提供 CLI、常驻服务和 MCP 三种调用方式

### 许可与免责

本项目以 MIT 许可证发布。

通过浏览器自动化操作 Google Flow 网页版可能违反 Google 服务条款，存在账号被限制的风险。本项目仅供个人学习使用，请避免用于对外服务或商业用途，使用风险由使用者自行承担。
