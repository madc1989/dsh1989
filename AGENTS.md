# 圆桌 · 给 AI 的操作手册

> 这份文件是写给**能在这台机器上执行命令的 AI**（DSH / Claude Code / Cursor / Codex CLI）看的，不是写给人的。
> 人只看 `README.md`。你要做的：按下面步骤把项目跑起来，然后告诉用户"能用了"。
>
> 如果你**没有本地执行能力**（你只是个网页聊天窗），那这份手册你执行不了：
> 请把上面的步骤逐条转述给用户，让他自己在终端里跑。不要假装已经装好了。

---

## 一、这是什么

一个本地多模型聊天室。几个模型放在同一个群里说话，也能开"议题"让它们各自独立作答、揭晓、对比、出纪要。

技术形态：**一个 Node 服务（`server.mjs`）+ 一个单文件前端（`public/index.html`）**，零第三方依赖，不编译，不打包。

## 二、前提条件（先检查，不满足就别往下走）

| 需要 | 怎么确认 |
|---|---|
| Node ≥ 18 | `node -v` |
| **本机装有 DeepSeek Harness（DSH）且至少配过一条模型线路** | 存在 `~/.dsh/.credentials.yaml` |
| 或者：本机有 LM Studio 跑着 qwen3-8b | `curl http://127.0.0.1:1234/v1/models` |

**这个项目的设计前提就是"你已经有 DSH"**，凭据直接复用 DSH 的那份文件，不自己存 Key。
如果用户没有 DSH，告诉他：先去装 DSH 并在里面配好一个模型，再回来。

先跑自检：

```bash
node tools/check.mjs
```

它会逐项报「可用 / 缺什么」，比读文档快。**按它的输出决定下一步。**

## 三、跑起来

```bash
node server.mjs --port 3000
# 然后打开 http://127.0.0.1:3000
```

可选参数：`--port`（默认 3000）、`--host`（默认 `127.0.0.1`）、`--max-rounds`（默认 6）。

> **默认只监听本机**。想用手机/平板访问，才显式加 `--host 0.0.0.0`——那等于把整个聊天室暴露给同网段所有人（能读记录、能发消息花你的额度），没有密码保护。

**Windows 后台常驻**（开机自启）：把下面写进启动文件夹的 `.vbs`，用 `wscript` 运行：

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run """node.exe"" ""<repo>\supervise.mjs""", 0, False
```

`supervise.mjs` 是守护进程：崩了 3 秒后自动拉起，日志写 `logs/server.log`。

## 四、加一个模型

界面：左侧「成员」标题右边 **＋ → 添加模型** → 选线路 → 选模型 → 起名。

四种线路，对应关系如下（**Key 不在这个项目里，在 DSH 的凭据文件里**）：

| 线路 | 需要的凭据（`~/.dsh/.credentials.yaml` 的 `refs:` 段） | 模型 |
|---|---|---|
| `deepseek-official` | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen3.8-flash` / `qwen3.8-max` |
| `moonshotai-cn` | `MOONSHOTAI_CN_API_KEY` | `kimi-k2.7-code`（**temperature 必须为 1**，代码里已写死） |
| `kimi-coding` | DSH 的 Kimi 订阅登录（`llm-pi-ai/kimi-coding:` 段） | `kimi-for-coding` / `k3` |
| `qwen3-8b` | **不要 Key**，走 `127.0.0.1:1234` | `qwen3-8b` |

凭据段长这样：

```yaml
refs:
  DEEPSEEK_API_KEY: 'sk-xxxx'
  QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-yyyy'
```

**改了凭据要重启服务**（`refs` 只在启动时读一次；Kimi 的 access token 例外，每次请求都重读）。

## 五、常见问题（按出现频率排）

| 现象 | 原因 | 处理 |
|---|---|---|
| `EADDRINUSE` | 已经有一个实例在跑 | 别再起第二个，直接开浏览器 |
| 页面能开，但发消息没反应 | 线路凭据缺失或失效 | 跑 `node tools/check.mjs` |
| 「模型」下拉是空的 | 前端没取到 `/api/catalog`（网络/端口不对） | 换线路或刷新页面 |
| 某个模型反复说同一句话 | 小模型在抄自己历史 | **清空该对话**再试 |
| Kimi 报 token 过期 | 订阅 access token 只有约 8 分钟寿命 | 不要手动 refresh（会轮换掉 refresh token），直接在 DSH 里用一次 Kimi，它会自己刷新 |
| 议题揭晓前拿不到候选正文 | **这是特性**：未揭晓时后端不下发 | 不是 bug |
| 手机打开是登录页 | 正常。局域网设备要输口令，电脑本机不用 | 口令在电脑的 ⚙ 设置 → 📱 手机访问 |
| 手机地址打不开 | 重启后路由器重新分配了 IP | 看 ⚙ 设置 → 📱 手机访问 里的当前地址，或在路由器里绑固定 IP |

## 六、数据在哪

```
data/room.jsonl      所有消息（一行一条 JSON）
data/auth.json       局域网访问口令（6 位数字，可改）
data/rooms.json      房间与成员归属
data/members.json    成员：名字、线路、模型、人设、立绘、代表色、关系、作息…
data/topics.json     议题：材料、槽位（各人独立产出）、纪要
data/settings.json   每个会话的上下文长度 / 模式 / 自动续拍
data/uploads/        用户上传的图片（立绘、附件）
logs/server.log      服务输出（supervise.mjs 写的）
```

备份 = 拷整个 `data/` 目录。恢复 = 覆盖回去，重启。

## 七、改代码前必读（踩过的坑）

1. **`public/index.html` 是 CRLF，`server.mjs` 是 LF**。用脚本做多行替换时要先归一化换行符，否则锚点永远匹配不上。
2. **`const HTML = readFileSync(...)` 在启动时只读一次** —— 改了 `index.html` 必须重启服务才生效。
3. **函数重名会静默覆盖**（JS 函数声明后者胜）。加函数前先 grep 一遍名字。曾经 `openRename` 被定义两次，导致"改群名"实际改了窗口标题。
4. **两处渲染同一件东西时，颜色/头像要用同一个取值函数**。曾经消息气泡有两条渲染路径（历史 vs 流式），一条用成员代表色、一条用哈希色，看起来像"颜色自己变了"。
5. **本机 8B 调用要在 turnNote 末尾加 `/no_think`**，否则思考内容吃光 token 返回空。
6. **提示词里的硬事实要放最前面**。放末尾时小模型会忽略（8B 实测：档案放在末尾它就答"我不确定自己的年龄"）。
7. **`deepseek-v4-flash-vision-exp` 必须给 `max_tokens: 2000`**。它的推理会吃掉大部分额度：给 400/800/1200 时 **HTTP 200 但 content 是空字符串**，超时都不会报——图片附件会静默没有描述，模型只能瞎猜。2026-10-21 同一天踩了两次（附件识别 + 生成"我的样子"）。
8. **视频是"抽帧 + 转文字"，不是理解视频**。ffmpeg 每秒抽 1 帧（上限 `RT_VIDEO_FRAMES`，默认 30），每帧走视觉模型，拼成"第N秒：…"。超过上限时**均匀铺满全程**（不是只取前 N 秒）。**没有音轨**——说话、音乐、旁白全都听不到。没装 ffmpeg 时降级为只有文件名，不会中断上传。
9. **附件抽取内容不要拼进用户可见的文本**。`material.text` 只放用户写的原文（聊天里显示这个），附件内容单独存 `material.extract`，只喂给模型。否则聊天气泡里会出现一大段"【附件1：xxx】+ 视觉描述"。

## 八、目录结构

```
server.mjs          后端全部逻辑（HTTP + SSE + 调用模型 + 议题状态机）
public/index.html   前端全部（原生 DOM，无框架）
supervise.mjs       守护进程（崩了自动重启）
docs/议题规格.md     议题的设计规格（七个状态、揭晓机制、纪要格式）
tools/check.mjs     环境自检
data/               运行时数据（不进 git）
```

## 九、你要替用户确认的三件事

1. `node tools/check.mjs` 至少有一项「可用」
2. 浏览器打开 `http://127.0.0.1:3000` 能看到**主界面的人物卡**
3. 随便发一句，**有模型回话**

三条都过了，才算装好。
