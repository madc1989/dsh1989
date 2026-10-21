/**
 * 圆桌服务守护（替代 .cmd 版本 —— 批处理读中文路径会糊，node 不会）。
 *
 * 作用：
 *   1) 崩了自动拉起（3 秒后重试）
 *   2) 所有输出写进 logs/server.log，下次崩了能查到死因
 *
 * 由启动文件夹的 圆桌-自动启动.vbs 以隐藏窗口调用：
 *   node supervise.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(ROOT, 'server.mjs')
const LOG_DIR = path.join(ROOT, 'logs')
const LOG = path.join(LOG_DIR, 'server.log')
const NODE = process.execPath
const PORT = process.env.RT_PORT || '3000'
const HOST = process.env.RT_HOST || '0.0.0.0'   // 守护模式下默认开放局域网（手机访问）；只想本机就设 RT_HOST=127.0.0.1

fs.mkdirSync(LOG_DIR, { recursive: true })

function stamp(level, msg) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}\n`
  fs.appendFileSync(LOG, line, 'utf8')
  process.stdout.write(line)
}

let child = null
let stopping = false
let crashes = 0
const MAX_CRASHES = 5   // 连续崩 5 次就停：多半是代码语法错，无限重启只会刷爆日志

function start() {
  stamp('info', `starting ${SERVER} --port ${PORT}`)
  const out = fs.openSync(LOG, 'a')
  child = spawn(NODE, [SERVER, '--port', PORT, '--host', HOST], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  const startedAt = Date.now()
  child.on('exit', (code, signal) => {
    if (stopping) return
    // 跑够 60 秒算"正常退出后再崩"，重置计数；秒退 = 代码有问题，连续几次就停下
    const lived = Date.now() - startedAt
    if (lived > 60_000) crashes = 0
    crashes++
    stamp('warn', `server exited code=${code} signal=${signal}，存活 ${Math.round(lived / 1000)}s，连续失败 ${crashes}/${MAX_CRASHES}`)
    if (crashes >= MAX_CRASHES) {
      stamp('error', `连续 ${crashes} 次启动失败，守护停止。请手工看上面的报错；修好后重新运行 supervise.mjs`)
      process.exit(1)
    }
    setTimeout(start, 3000 * Math.min(crashes, 5))   // 退避：3s → 6s → 9s…
  })
  child.on('error', (e) => stamp('error', `spawn failed: ${e.message}`))
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true
    stamp('info', 'supervisor stopping')
    try { child && child.kill() } catch {}
    process.exit(0)
  })
}

start()
