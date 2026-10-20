#!/usr/bin/env node
/**
 * 圆桌 · 环境自检
 *   node tools/check.mjs
 *
 * 逐项报「可用 / 缺什么」，最后给一句"下一步该做什么"。
 * 给 AI 读的：退出码 0 = 至少一条线路可用；1 = 一条都没有。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const DATA = path.join(ROOT, 'data')

const OK = '\x1b[32m✅\x1b[0m'
const NO = '\x1b[31m❌\x1b[0m'
const MAYBE = '\x1b[33m⚪\x1b[0m'
const DIM = (s) => `\x1b[2m${s}\x1b[0m`

const rows = []
let usable = 0
const line = (icon, name, detail) => { rows.push({ icon, name, detail }); if (icon === OK) usable++ }

// 1. Node
const major = Number(process.versions.node.split('.')[0])
line(major >= 18 ? OK : NO, `Node ${process.versions.node}`, major >= 18 ? '' : '需要 ≥ 18')

// 2. 凭据文件
let credText = ''
if (fs.existsSync(CRED)) {
  credText = fs.readFileSync(CRED, 'utf8')
  line(OK, 'DSH 凭据文件', DIM(CRED))
} else {
  line(NO, 'DSH 凭据文件', `找不到 ${CRED} —— 先装 DeepSeek Harness 并配好一个模型`)
}

// 3. refs 段里的各家 Key
const refsOf = {}
{
  const m = /(^|\n)refs:\n((?:\s{2,}[^\n]*\n?)+)/.exec(credText)
  if (m) {
    for (const l of m[2].split('\n')) {
      const kv = /^\s+([A-Z0-9_]+):\s*'?([^'\n]*)'?\s*$/.exec(l)
      if (kv) refsOf[kv[1]] = kv[2]
    }
  }
}
const wants = [
  ['deepseek-official', 'DEEPSEEK_API_KEY', 'DeepSeek（deepseek-flash）'],
  ['qwen-token-plan-cn', 'QWEN_TOKEN_PLAN_CN_API_KEY', '千问（qwen3.8-flash）'],
  ['moonshotai-cn', 'MOONSHOTAI_CN_API_KEY', 'Kimi 按量（kimi-k2.7-code）'],
]
for (const [, ref, label] of wants) {
  const v = refsOf[ref]
  if (v && v.trim()) line(OK, label, `${ref} 已配置（${v.length} 字符）`)
  else line(MAYBE, label, `缺 ${ref}`)
}

// 4. Kimi 订阅
const hasKimi = /llm-pi-ai\/kimi-coding:/.test(credText)
line(hasKimi ? OK : MAYBE, 'Kimi 订阅（kimi-for-coding / k3）', hasKimi ? '已登录（access token 约 8 分钟寿命，会自动刷新）' : '没登录，可在 DSH 里用一次 Kimi')

// 5. 本机 LM Studio
async function probeLocal() {
  try {
    const ctl = AbortSignal.timeout(2500)
    const r = await fetch('http://127.0.0.1:1234/v1/models', { signal: ctl })
    if (!r.ok) return line(MAYBE, '本机 8B（LM Studio）', `端口通但返回 ${r.status}`)
    const j = await r.json()
    const ids = (j.data || []).map((m) => m.id)
    line(OK, '本机 8B（LM Studio）', ids.length ? ids.join(', ') : '已就绪')
  } catch {
    line(MAYBE, '本机 8B（LM Studio）', '127.0.0.1:1234 连不上（不装也不影响云端线路）')
  }
}

// 6. 端口
function portFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 700 })
    const done = (v) => { try { sock.destroy() } catch {} resolve(v) }
    sock.once('connect', () => done(false))   // 连得上 = 有人监听
    sock.once('timeout', () => done(true))
    sock.once('error', () => done(true))
  })
}

// 7. 数据
function checkData() {
  if (!fs.existsSync(DATA)) return line(MAYBE, '数据目录', '还没生成，首次启动会自动建')
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) } catch { return null } }
  const members = read('members.json')
  const rooms = read('rooms.json')
  let msgs = 0
  try { msgs = fs.readFileSync(path.join(DATA, 'room.jsonl'), 'utf8').split('\n').filter(Boolean).length } catch {}
  line(OK, '数据目录', `${members ? members.length : 0} 位成员 / ${rooms ? Object.keys(rooms).length : 0} 个房间 / ${msgs} 条消息`)
}

await probeLocal()
checkData()
const free = await portFree(3000)
line(free ? OK : MAYBE, '端口 3000', free ? '空闲' : '已被占用 —— 已经有实例在跑，直接打开 http://127.0.0.1:3000')

// 输出
console.log('\n圆桌 · 环境自检\n' + '─'.repeat(52))
for (const r of rows) console.log(`${r.icon} ${r.name}${r.detail ? '\n   ' + r.detail : ''}`)
console.log('─'.repeat(52))

// 只统计"模型线路"能不能用（端口/数据不算）
const modelOk = rows.filter((r) => !['Node', 'DSH 凭据文件', '端口 3000', '数据目录'].some((k) => r.name.startsWith(k)) && r.icon === OK).length

if (modelOk === 0) {
  console.log(`${NO} 没有任何可用的模型线路。\n\n下一步：\n  1. 装 DeepSeek Harness，在里面配好至少一个模型（会写进 ${CRED}）\n  2. 或者启动 LM Studio 并加载 qwen3-8b\n  3. 然后重新跑本命令\n`)
  process.exit(1)
}

if (free) {
  console.log(`${OK} ${modelOk} 条线路可用 —— 可以启动：\n\n  node server.mjs --port 3000\n  然后打开 http://127.0.0.1:3000\n`)
} else {
  console.log(`${OK} ${modelOk} 条线路可用，而且服务已经在跑：\n\n  直接打开 http://127.0.0.1:3000\n  （要换端口就 node server.mjs --port 3001）\n`)
}
process.exit(0)
