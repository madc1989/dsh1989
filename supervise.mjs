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

fs.mkdirSync(LOG_DIR, { recursive: true })

function stamp(level, msg) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}\n`
  fs.appendFileSync(LOG, line, 'utf8')
  process.stdout.write(line)
}

let child = null
let stopping = false

function start() {
  stamp('info', `starting ${SERVER} --port ${PORT}`)
  const out = fs.openSync(LOG, 'a')
  child = spawn(NODE, [SERVER, '--port', PORT], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  child.on('exit', (code, signal) => {
    if (stopping) return
    stamp('warn', `server exited code=${code} signal=${signal}，3 秒后重启`)
    setTimeout(start, 3000)
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
