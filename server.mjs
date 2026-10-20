// 圆桌 server.mjs v3 -- 微信式多模型聊天：两个群（工作/自由）+ 每个成员的一对一私聊
// 运行: <DSH node> 圆桌/server.mjs [--port 3000] [--host 127.0.0.1] [--max-rounds 6]
// 凭据复用 ~/.dsh/.credentials.yaml；本机 8B 走 127.0.0.1，断网仍可用。

import http from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------- 常量 ----------
const ROOT = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.PORT || 3000));
// 默认只监听本机：局域网上别人打开 IP:端口 就能读你的聊天、花你的额度。
// 确实要手机访问时显式开：--host 0.0.0.0
const HOST = arg('--host', process.env.RT_HOST || '127.0.0.1');
const MAX_ROUNDS = Number(arg('--max-rounds', 6));
const HIST_CHARS = 6000;   // 默认窗口预算；每个会话可在界面里单独覆盖
const DATA = join(ROOT, 'data');
const LOG = join(DATA, 'room.jsonl');
const MEMBERS_FILE = join(DATA, 'members.json');
const ROOMS_FILE = join(DATA, 'rooms.json');
const SETTINGS_FILE = join(DATA, 'settings.json');
const UPLOAD_DIR = join(DATA, 'uploads');
const CRED = join(homedir(), '.dsh', '.credentials.yaml');
const KIMI_PROBE = join(ROOT, '..', 'tools', 'out', 'kimi-refresh-probe.mjs');

const ROUTES = {
  'deepseek-official': { kind: 'openai', base: 'https://api.deepseek.com', ref: 'DEEPSEEK_API_KEY' },
  'moonshotai-cn': { kind: 'openai', base: 'https://api.moonshot.cn/v1', ref: 'MOONSHOTAI_CN_API_KEY', temp: 1 },
  'qwen-token-plan-cn': { kind: 'openai', base: 'https://maas.qianwenaiapi.com/compatible-mode/v1', ref: 'QWEN_TOKEN_PLAN_CN_API_KEY' },
  'qwen3-8b': { kind: 'openai', base: 'http://127.0.0.1:1234/v1', ref: null },
  'kimi-coding': { kind: 'anthropic', base: 'https://api.kimi.com/coding' },
};
const LOCAL_PROVIDER = 'qwen3-8b';

// 可选模型目录（供「添加模型」下拉使用）
const CATALOG = {
  'deepseek-official': ['deepseek-flash'],
  'kimi-coding': ['kimi-for-coding', 'k3'],
  'moonshotai-cn': ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
  'qwen-token-plan-cn': ['qwen3.8-flash', 'qwen3.8-max'],
  'qwen3-8b': ['qwen3-8b'],
};

// ---------- 成员 ----------
mkdirSync(DATA, { recursive: true });
if (!existsSync(MEMBERS_FILE)) writeFileSync(MEMBERS_FILE, JSON.stringify([
  { id: 'kimi', name: 'Kimi', provider: 'kimi-coding', model: 'kimi-for-coding', persona: null },
  { id: 'ds', name: 'DeepSeek', provider: 'deepseek-official', model: 'deepseek-flash', persona: null },
  { id: 'k27', name: 'K2.7-code', provider: 'moonshotai-cn', model: 'kimi-k2.7-code', persona: null },
  { id: 'qw', name: 'Qwen3.8', provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', persona: null },
  { id: 'local', name: '本机8B', provider: 'qwen3-8b', model: 'qwen3-8b', persona: null },
  { id: 'k3', name: 'K3', provider: 'kimi-coding', model: 'k3', persona: null },
], null, 2), 'utf8');
const members = JSON.parse(readFileSync(MEMBERS_FILE, 'utf8'));
const saveMembers = () => writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2), 'utf8');
const memberById = (id) => members.find(m => m.id === id);

// ---------- 群（工作 / 自由） ----------
if (!existsSync(ROOMS_FILE)) writeFileSync(ROOMS_FILE, JSON.stringify({
  work: { name: '工作模式', members: ['kimi', 'ds', 'k27'] },
  free: { name: '自由模式', members: members.map(m => m.id) },
}, null, 2), 'utf8');
let rooms = JSON.parse(readFileSync(ROOMS_FILE, 'utf8'));
const saveRooms = () => writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
const GROUP_IDS = ['work', 'free'];   // 默认群；此外用户可自建任意群
const roomInfo = (id) => {
  if (id?.startsWith('dm:')) { const mb = memberById(id.slice(3)); return mb ? { id, kind: 'dm', name: mb.name, members: [mb] } : null; }
  const r = rooms[id]; return r ? { id, kind: 'group', name: r.name, members: r.members.map(memberById).filter(Boolean) } : null;
};

// ---------- 每个会话的独立设置（目前只有上下文窗口） ----------
let roomSettings = existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : {};
const saveSettings = () => writeFileSync(SETTINGS_FILE, JSON.stringify(roomSettings, null, 2), 'utf8');
const histFor = (roomId) => {
  const v = Number(roomSettings[roomId]?.histChars);
  return Number.isFinite(v) && v >= 500 ? v : HIST_CHARS;
};
const roundsFor = (roomId) => {
  const v = Number(roomSettings[roomId]?.maxRounds);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.round(v), 50) : MAX_ROUNDS;
};

// 附件内容提取：文本直接读正文，图片调视觉模型转描述，视频/其它只留文件名
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'log', 'js', 'mjs', 'ts', 'py', 'html', 'htm', 'css', 'yml', 'yaml', 'xml', 'sql', 'ini', 'sh', 'ps1', 'bat']);
const EXTRACT_CHARS = 6000;
async function enrichAttach(attach, buf, safeName) {
  const ext = String(safeName.split('.').pop() || '').toLowerCase();
  const mime = attach.mime || '';
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) {
    const txt = buf.toString('utf8');
    attach.chars = txt.length;
    attach.text = txt.slice(0, EXTRACT_CHARS);
  } else if (mime.startsWith('image/')) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${refs.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash-vision-exp', max_tokens: 800,
          messages: [{ role: 'user', content: [
            { type: 'text', text: '用中文简洁描述这张图片的内容（不超过 200 字）；如果图中有文字，把关键文字转录出来。只输出描述。' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
          ] }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (r.ok) {
        const j = await r.json();
        attach.desc = String(j.choices?.[0]?.message?.content || '').trim().slice(0, 1200);
      } else { attach.descErr = `vision ${r.status}`; }
    } catch (e) { attach.descErr = e.message; }
  }
  return attach;
}

// ---------- 消息记录（旧记录无 room 字段 → 迁入自由模式） ----------
const rawLog = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
let migrated = false;
const log = rawLog.map(rec => { if (!rec.room) { migrated = true; return { ...rec, room: 'free' }; } return rec; });
if (migrated) writeFileSync(LOG, log.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const appendLog = (rec) => { log.push(rec); appendFileSync(LOG, JSON.stringify(rec) + '\n', 'utf8'); };
const flushLog = () => writeFileSync(LOG, log.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

// ---------- 凭据（每次读盘：kimi access 只有 ~8 分钟寿命） ----------
const readCred = () => readFileSync(CRED, 'utf8');
const refs = {};
{
  const m = /(^|\n)refs:\n((?:\s{2,}[^\n]*\n?)+)/.exec(readCred());
  if (m) for (const line of m[2].split('\n')) {
    const kv = /^\s+([A-Z0-9_]+):\s*'?([^'\n]*)'?\s*$/.exec(line);
    if (kv) refs[kv[1]] = kv[2];
  }
}
const kimiField = (name) => {
  const t = readCred();
  const i = t.indexOf('llm-pi-ai/kimi-coding:');
  if (i < 0) return null;
  const m = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`, 'm').exec(t.slice(i, i + 2000));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
};
function kimiAccess() {
  const exp = Number(kimiField('expires') ?? 0);
  if (exp < Date.now() + 60_000) {
    console.log('[kimi] access expired, running refresh probe...');
    const r = spawnSync(process.execPath, [KIMI_PROBE], { encoding: 'utf8', timeout: 60_000 });
    console.log('[kimi] probe exit', r.status);
  }
  return kimiField('access');
}

// ---------- 模型适配 ----------
async function* streamLines(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
}
async function* askOpenAI(route, member, system, turns, signal) {
  const res = await fetch(route.base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(route.ref ? { authorization: `Bearer ${refs[route.ref]}` } : {}) },
    body: JSON.stringify({ model: member.model, stream: true, temperature: route.temp ?? 0.7, messages: [{ role: 'system', content: system }, ...turns] }),
    signal: signal ?? AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for await (const line of streamLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim(); if (data === '[DONE]') return;
    try { const c = JSON.parse(data).choices?.[0]?.delta?.content; if (c) yield c; } catch {}
  }
}
async function* askAnthropic(member, system, turns, signal) {
  const access = kimiAccess(); if (!access) throw new Error('kimi access token unavailable');
  const res = await fetch('https://api.kimi.com/coding/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${access}`, 'x-api-key': access, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: member.model, max_tokens: 4096, stream: true, system, messages: turns.map(t => ({ role: t.role, content: t.content })) }),
    signal: signal ?? AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for await (const line of streamLines(res)) {
    if (!line.startsWith('data:')) continue;
    try { const d = JSON.parse(line.slice(5).trim()); if (d.type === 'content_block_delta' && d.delta?.text) yield d.delta.text; } catch {}
  }
}
async function* askMember(member, system, turns, signal) {
  const route = ROUTES[member.provider];
  if (!route) throw new Error(`unknown provider ${member.provider}`);
  yield* route.kind === 'anthropic' ? askAnthropic(member, system, turns, signal) : askOpenAI(route, member, system, turns, signal);
}

// ---------- 转发（仅用户可发起；链路无限、可追溯；到接收方只当参考材料） ----------
const roomLabelOf = (id) => roomInfo(id)?.name ?? id;
function flattenForward(rec, srcRoom) {
  if (rec.forward?.items?.length) return rec.forward.items.map(it => ({ ...it, chain: [...(it.chain || []), srcRoom] }));
  return [{ text: rec.text, from: rec.from, ts: rec.ts, chain: [srcRoom] }];
}

// ---------- 上下文 ----------
const fmt = (rec) => {
  if (rec.kind === 'forward') {
    const lines = (rec.forward?.items || []).map(it => {
      const t = new Date(it.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `〔转发自 ${it.chain.map(roomLabelOf).join(' → ')}｜${it.from}｜${t}〕${it.text}`;
    }).join('\n');
    return `你：（以下是你转发进本会话的参考材料，不是本会话的结论，不要当作已有共识）${rec.text ? '\n你的说明：' + rec.text : ''}\n${lines}`;
  }
  if (rec.kind === 'system') return `〔系统记录〕${rec.text}`;   // 删除留痕等提示，让模型明确看到上下文断点
  let att = '';
  if (rec.attach) {
    const a = rec.attach;
    const kindName = { image: '图片', video: '视频', file: '文件' }[a.kind] || '附件';
    att = `\n（附件：${a.name}｜${kindName}${a.text ? '｜正文见下' : ''}${a.desc ? '｜视觉识别见下' : ''}）`;
    if (a.text) att += `\n"""\n${a.text}${a.chars > (a.text.length) ? `\n……（以上为前 ${a.text.length} 字符，原文共 ${a.chars} 字符）` : ''}\n"""`;
    if (a.desc) att += `\n[图片内容] ${a.desc}`;
  }
  return `${rec.kind === 'user' ? '你' : rec.from}：${stripPrefix(rec.text)}${att}`;
};
// upTo：只取 log 下标 < upTo 的记录。独立模式用它把「本轮此前成员的发言」挡在上下文外。
function recentTurns(roomId, budgetOverride, upTo) {
  const budget = budgetOverride || histFor(roomId);
  const out = []; let size = 0;
  const top = Math.min(log.length, upTo ?? log.length);
  for (let i = top - 1; i >= 0; i--) {
    if (log[i].room !== roomId) continue;
    if (log[i].meta?.noHist) continue;                  // 只给界面看的记录（如独立模式提示），不进上下文
    // 兼容旧记录：meta 里还没有 noHist 的那些「独立模式」提示，同样挡在上下文外（它们会被当成 assistant 发言接着往下写）
    if (log[i].kind === 'system' && String(log[i].text || '').startsWith('（独立模式')) continue;
    const s = fmt(log[i]); if (size + s.length > budget) break;
    out.unshift({ role: log[i].kind === 'user' ? 'user' : 'assistant', content: s });
    size += s.length;
  }
  return out;
}
function systemPrompt(member, room, extra = '') {
  const roomPersona = roomSettings[room.id]?.personas?.[member.id];
  const persona = roomPersona
    ? `\n本会话对你的设定：${roomPersona}。这是你在这个群里的固定身份，每一轮都要按它说话、按它判断。`
    : member.persona ? `\n你的当前设定：${member.persona}。始终以此设定发言。` : '';
  const roomMode = roomSettings[room.id]?.mode;
  const modeLine = roomMode === 'persona'
    ? '\n本会话处于「设定模式」：每个成员都有明确分工，按你的设定发言，不要抢别人的活，也不要泛泛附和。'
    : roomMode === 'isolated'
      ? '\n本会话处于「独立模式」：**历史是共享的**——前几轮谁说过什么你都能看到，跨轮的信息照常引用；但**本轮**其他成员也在同时回答，你看不到他们此刻的答案。所以：本轮不要揣测别人说了什么，也不要为了配合别人而含糊其辞，按你自己的判断直接作答（别把「本轮看不到」理解成「连历史也看不到」）。'
      : roomMode === 'flow'
        ? '\n本会话处于「自由模式」：一群人在闲聊，谁开口是随机决定的、不一定轮到你，也不是每个人都必须说。**像发微信那样说话：一两句，别写小作文，别给自己加"先分析再总结"的结构。** 可以接任何人的话，也可以换话题、翻旧账、只说半句、表示不同意；没什么想补的就回「沉默」。不要每句都追着上一句打补丁，真人聊天是会跳的。'
        : '';
  const peers = room.kind === 'group' ? `当前群「${room.name}」里的成员：${room.members.map(m => m.name).join('、')}。` : '';
  const addressing = roomSettings._app?.addressing || 'MD';
  const callLine = `\n用户希望你称呼 TA 为「${addressing}」，需要称呼时就这么叫。`;
  // 人物卡的档案：语气要硬，否则模型（尤其小模型）会顺着"我什么都不知道"的人设答非所问
  const profileLine = (() => {
    const parts = [];
    if (member.gender) parts.push(`性别 ${member.gender}`);
    if (member.age) parts.push(`年龄 ${member.age} 岁`);
    if (member.outfit) parts.push(`穿着 ${member.outfit}`);
    if (member.role) parts.push(`在这间 AI 聊天室主要负责 ${member.role}`);
    if (!parts.length) return '';
    return `\n【你的档案】${parts.join('；')}。别人问起这些，照实回答，不要说"不知道""没数过"。`;
  })();
  // 人物卡里设的"和其他成员的关系"：只写进提示词，不做强制
  const relLine = (() => {
    const rel = member.relations || {};
    const rows = room.members.filter(x => x.id !== member.id && rel[x.id])
      .map(x => `${x.name}${x.age ? `（${x.age}岁）` : ''}：${rel[x.id]}`);
    return rows.length ? `\n你和他们的关系：${rows.join('；')}。` : '';
  })();
  return `你是多模型讨论室「圆桌」的成员「${member.name}」（底层模型 ${member.provider}/${member.model}）。${profileLine}${persona}${modeLine}
${peers}你在一${room.kind === 'group' ? '个群聊' : '对一私聊'}里，可以有其他 AI 成员和你观点不同；可以赞同、反驳、补充任何成员，自然提及对方名字。${callLine}${relLine}
发言要简洁、口语化（一般不超过 200 字），不要 Markdown 标题和列表。
历史里用「名字：内容」标记谁说了什么，那是记录格式，不是你的发言格式。
历史里以〔系统记录〕开头的是系统提示（建群、模式说明、调整顺序之类），那**不是你自己的发言**，不要复述它、也不要接着它往下写。
**重要：回复时直接说内容，绝对不要在开头写自己的名字、也不要用【】或“名字：”起头。**${extra}`;
}
function maybeRecall(text, roomId) {
  const m = /看下?之前(?:关于|提到)?(.{1,20}?)(?:的)?(?:对话|讨论|内容|说法)/.exec(text);
  if (!m) return '';
  const kw = m[1].trim(); if (!kw) return '';
  const hits = log.filter(r => r.room === roomId && r.text.includes(kw)).slice(-3);
  if (!hits.length) return `\n（用户让你回顾之前关于「${kw}」的内容，但没找到相关记录。）`;
  return `\n用户让你回顾之前关于「${kw}」的对话：\n` + hits.map(h => `- ${fmt(h)}`).join('\n');
}
function maybeSetPersona(text) {
  for (const mb of members) {
    const re = new RegExp(`(?:@?${mb.name})[^。！]{0,6}?(?:你是|你从现在起(?:是)?|扮演)`);
    if (re.test(text)) {
      const seg = text.split(/你是|你从现在起(?:是)?|扮演/)[1] ?? '';
      const persona = seg.split(/[。！\n]/)[0].replace(/^是/, '').trim();
      if (persona.length >= 2 && persona.length <= 60) { mb.persona = persona; saveMembers(); return `已设定 ${mb.name} 的角色：${persona}`; }
    }
  }
  return null;
}

// ---------- 前缀剥离 ----------
function stripPrefix(text) {
  let t = text;
  for (let i = 0; i < 4; i++) {
    const m = /^(?:【[^】]{1,14}】\s*|([^\s：:，。]{1,14})\s*[：:]\s*)/.exec(t);
    if (!m) break;
    const bare = m[0].replace(/[【】：:\s]/g, '');
    const looksLikeName = m[0].startsWith('【') ||
      members.some(mb => bare === mb.name || bare === mb.id || bare === mb.model || mb.name.startsWith(bare) || bare.startsWith(mb.name));
    if (!looksLikeName) break;
    t = t.slice(m[0].length);
  }
  return t;
}

// ---------- 运行时状态 ----------
// 互搏状态按房间各自独立（A 群在辩论不影响你在 B 群私聊）
const debates = new Map();
const sseClients = new Set();
const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of sseClients) c.write(`data: ${s}\n\n`); };
const addRec = (rec) => { appendLog(rec); broadcast({ type: 'msg', rec }); };

const DOWN_AFTER = 2, DOWN_COOLDOWN = 15 * 60_000;
const mstate = {};
const stateOf = (id) => mstate[id] ??= { fails: 0, down: false, lastFail: 0, speaking: false };
const emitStatus = (mb) => broadcast({ type: 'status', id: mb.id, name: mb.name, ...stateOf(mb.id) });
const noteDown = (mb) => { const st = stateOf(mb.id); return st.down && (Date.now() - st.lastFail < DOWN_COOLDOWN); };

const NET_TTL = 12_000;
const NET_PROBE_URL = process.env.NET_PROBE_URL || 'https://api.deepseek.com';
let netOnline = true, netCheckedAt = 0, netProbing = null;
const isCloud = (mb) => mb.provider !== LOCAL_PROVIDER;
const offlineFor = (mb) => isCloud(mb) && !netOnline;
async function refreshNet() {
  if (Date.now() - netCheckedAt < NET_TTL) return netOnline;
  if (netProbing) return netProbing;
  netProbing = (async () => {
    let ok = false;
    try { await fetch(NET_PROBE_URL, { method: 'HEAD', signal: AbortSignal.timeout(3000) }); ok = true; } catch { ok = false; }
    netCheckedAt = Date.now();
    if (ok !== netOnline) {
      netOnline = ok;
      addRec({ id: 's' + Date.now(), ts: Date.now(), room: 'free', kind: 'system', from: 'system', text: ok ? '（网络已恢复，云端成员重新上线）' : '（网络离线：云端成员已挂起，仅本机8B 可达）', meta: {} });
      broadcast({ type: 'net', online: ok });
    }
    return ok;
  })();
  try { return await netProbing; } finally { netProbing = null; }
}
// 后台每 10 秒探一次：断网/恢复时自己广播，不用等用户发消息才更新
setInterval(() => { refreshNet().catch(() => {}); }, 10_000);
setTimeout(() => { refreshNet().catch(() => {}); }, 1500);

// 每个会话一条独立队列 + 一个中断开关（用户发「停」时立刻掐断正在飞的请求）
const roomChains = new Map();
const roomCtl = new Map();
const ctlOf = (roomId) => roomCtl.get(roomId) ?? roomCtl.set(roomId, { cancel: false, acs: new Set(), jobs: 0 }).get(roomId);
// acs 是集合而非单个：独立模式下多个成员并发在飞，「停」要能一次全掐断。
const cancelRoom = (roomId, reason = 'stop') => { const c = ctlOf(roomId); c.cancel = true; c.reason = reason; for (const a of [...c.acs]) { try { a.abort(); } catch {} } };
// jobs 计数 = 这个会话队列里还有几件活在跑。用户中途发新消息时用它判断「上一轮还没说完」。
function enqueue(roomId, fn) {
  const c = ctlOf(roomId);
  c.jobs++;
  const prev = roomChains.get(roomId) ?? Promise.resolve();
  const next = prev.then(fn)
    .catch(e => console.error('[queue]', roomId, e))
    .finally(() => { c.jobs = Math.max(0, c.jobs - 1); });
  roomChains.set(roomId, next);
  return next;
}
// 本机 8B 单卡：只对它的调用做全局独占，云端模型仍可并发
let localChain = Promise.resolve();
function localLock(fn) {
  const run = localChain.then(fn);
  localChain = run.catch(() => {});
  return run;
}

// ---------- 发言 ----------
async function speak(member, room, extra, tag, histUpTo) {
  const st = stateOf(member.id);
  st.speaking = true; emitStatus(member);
  const rec = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), ts: Date.now(), room: room.id, kind: 'member', from: member.name, text: '', meta: tag };
  // ⚠️ 必须先算历史再写占位记录：否则本轮的空 assistant 记录会被当成"我已经开口了"喂给模型，
  //    小模型（本机 8B）会顺着它复读自己上一条 —— 2026-10-18 实测踩过。
  const budget = member.provider === LOCAL_PROVIDER ? Math.min(histFor(room.id), 3500) : undefined;
  // tag.turnNote 允许调用方改写这句话。自由模式必须改：默认那句「直接回答上面最后一条消息」= 明令接龙，
  // 会把自由模式逼成接力赛（每人都追着上一句打补丁）—— 2026-10-19 用户实测反馈。
  const rawNote = tag?.turnNote || (member.provider === LOCAL_PROVIDER
    ? '(现在轮到你发言。直接回答上面最后一条消息，不要重复你说过的话。)'
    : '(现在轮到你发言。直接回答上面最后一条消息的内容，不要重复你之前说过的话，也不要复述位置信息。)');
  const turnNote = member.provider === LOCAL_PROVIDER && !rawNote.includes('/no_think') ? rawNote + '/no_think' : rawNote;
  const system = systemPrompt(member, room, extra);
  const turns = [...recentTurns(room.id, budget, histUpTo), { role: 'user', content: turnNote }];
  appendLog(rec);                                          // 只落盘，不广播（避免前端画出空气泡）
  broadcast({ type: 'start', id: rec.id, from: member.name, room: room.id });
  let ok = true, aborted = false, pending = '', released = false;
  const ctl = ctlOf(room.id);
  const ac = new AbortController();
  ctl.acs.add(ac);
  ctl.calls = (ctl.calls || 0) + 1;                          // 本轮的模型调用次数：界面上常驻显示
  ctl.who = member.name; ctl.beat = tag?.beat ?? null; ctl.total = tag?.total ?? null;
  broadcast({ type: 'round', room: room.id, calls: ctl.calls, paused: !!ctl.paused, who: ctl.who, beat: ctl.beat, total: ctl.total });
  const signal = AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(180_000), ac.signal]) : ac.signal;
  const release = (chunk) => {
    if (released) { broadcast({ type: 'delta', id: rec.id, text: chunk }); return; }
    pending += chunk;
    if (pending.length >= 24) { released = true; const clean = stripPrefix(pending); if (clean) broadcast({ type: 'delta', id: rec.id, text: clean }); }
  };
  try {
    const run = async () => {
      for await (const chunk of askMember(member, system, turns, signal)) {
        rec.text += chunk; release(chunk);
      }
    };
    await (member.provider === LOCAL_PROVIDER ? localLock(run) : run());
  } catch (e) {
    ok = false;
    if (e?.name === 'AbortError' && ctl.cancel) {
      aborted = true;
      const partial = rec.text.trim();
      rec.text = (partial ? partial + '\n' : '') + (ctl.reason === 'newmsg' ? '（你发了新消息，这条被打断）' : '（已按你的要求中断）');
    } else {
      rec.text += `（${member.name} 发言失败：${e.message}）`;
    }
    broadcast({ type: 'delta', id: rec.id, text: rec.text });
  } finally {
    ctl.acs.delete(ac);
  }
  if (ok) {
    if (!released) { const clean = stripPrefix(pending); if (clean) broadcast({ type: 'delta', id: rec.id, text: clean }); }
    rec.text = stripPrefix(rec.text);
    if (!rec.text.trim()) { ok = false; rec.text = `（${member.name} 返回了空内容，已记为失败）`; broadcast({ type: 'delta', id: rec.id, text: rec.text }); }
    // 自由模式的「不接话」：模型回 沉默 就留一条痕迹（不显示那句废话，也不当失败）
    else if (/^[\s（(\[【「]*沉\s*默[\s）)\]】」。.!！]*$/.test(rec.text.trim())) {
      rec.text = `（${member.name} 没接话）`;
      // noHist：别让「（X 没接话）」进上下文 —— 小模型会照着它继续回沉默，连着四拍全哑（实测踩到）
      rec.meta = { ...(rec.meta || {}), silent: true, noHist: true };
      broadcast({ type: 'delta', id: rec.id, text: '（没接话）' });
    }
  }
  flushLog();
  broadcast({ type: 'end', id: rec.id, room: room.id, rec });
  if (ok) { st.fails = 0; st.down = false; }
  else if (!aborted) { st.fails++; st.lastFail = Date.now(); if (st.fails >= DOWN_AFTER) st.down = true; }   // 用户主动中断不算失败
  st.speaking = false; emitStatus(member);
  if (ctl.who === member.name) {                             // 说完了：状态条切回"空闲"
    ctl.who = null; ctl.beat = null; ctl.total = null;
    broadcast({ type: 'round', room: room.id, calls: ctl.calls, paused: !!ctl.paused, who: null });
  }
  return rec;
}
const skipNote = (room, mb, offline = false) => addRec({
  id: 's' + Date.now(), ts: Date.now(), room: room.id, kind: 'system', from: 'system',
  text: offline ? `（网络离线：${mb.name} 已挂起，本机8B 仍可用）` : `（${mb.name} 离线中：连续失败已跳过，冷却 ${Math.round(DOWN_COOLDOWN / 60000)} 分钟后自动重试）`,
  meta: {},
});

// ---------- 编排 ----------
// 「在场」：roomSettings[room].present[id] === false 表示本轮把他放到席外（不出席、不说话）
const isPresent = (roomId, id) => roomSettings[roomId]?.present?.[id] !== false;
function parseMention(text, list) {
  const t = text.replace(/＠/g, '@');
  const at = t.indexOf('@');
  if (at < 0) return null;
  const rest = t.slice(at + 1).trimStart().toLowerCase();
  return list.find(mb => [mb.name, mb.id, mb.model].some(k => rest.startsWith(String(k).toLowerCase())));
}
function parseDebate(text, list) {
  if (!/(讨论|聊聊|辩论|商量|对话)/.test(text)) return null;
  const found = list.filter(mb => text.includes(mb.name));
  return found.length >= 2 ? found.slice(0, 3) : null;
}
// ---------- 自由模式：一拍只让一个人说，谁开口按「发言倾向」加权随机 ----------
// 仿 SillyTavern 的 Natural Order：先认点名，再按倾向掷骰，都不中兜底随机（保证不会没人说）。
// fromUser=true 时点名是硬优先（你点谁谁接）；false（模型之间互称）只加权×2，不直接胜出 ——
// 否则两个模型互相喊名字就会锁成二人乒乓，第三个人永远插不进来（2026-10-19 实测踩到）。
function pickSpeaker(room, seedText, prevId, fromUser, exclude) {
  const avail = room.members.filter(mb => mb && !offlineFor(mb) && !noteDown(mb) && !(exclude && exclude.has(mb.id)) && isPresent(room.id, mb.id));
  if (!avail.length) return null;
  const s = String(seedText || '').toLowerCase();
  const isNamed = (mb) => !!s && s.includes(String(mb.name).toLowerCase());
  if (fromUser && s) {                              // ① 你点名的，硬优先（不点自己）
    const named = avail.find(mb => mb.id !== prevId && isNamed(mb));
    if (named) return named;
  }
  const w = roomSettings[room.id]?.talkativeness || {};
  const talkOf = (mb) => Number(mb.talk ?? 50);                    // 只用成员卡里的"发言积极度"（全局）
  const willing = avail.filter(mb => talkOf(mb) > 0);              // ② 0 = 不主动开口（被点名仍会说）
  const pool = willing.length ? willing : avail;                    // ③ 全员 0 时兜底
  const weightOf = (mb) => {
    let base = willing.length ? Math.max(1, talkOf(mb)) : 1;
    if (mb.id === prevId) base *= 0.5;              // 刚说过的人权重减半：允许连说，但不让他独霸
    else if (!fromUser && isNamed(mb)) base *= 2;   // 模型互称：加权但不必中，避免二人乒乓
    return base;
  };
  const total = pool.reduce((s, mb) => s + weightOf(mb), 0);
  let r = Math.random() * total;
  for (const mb of pool) { r -= weightOf(mb); if (r <= 0) return mb; }
  return pool[pool.length - 1];
}
async function runDebate(room) {
  const d = debates.get(room.id);
  const maxR = roundsFor(room.id);
  while (d && d.round < maxR) {
    if (ctlOf(room.id).cancel) break;                  // 用户喊停
    if (d.members.every(mb => noteDown(mb) || offlineFor(mb))) {
      addRec({ id: 's' + Date.now(), ts: Date.now(), room: room.id, kind: 'system', from: 'system', text: '（讨论成员均不可用，专题讨论提前结束）', meta: {} }); break;
    }
    const mb = d.members[d.idx];
    if (noteDown(mb)) { skipNote(room, mb); d.idx = (d.idx + 1) % d.members.length; continue; }
    if (offlineFor(mb)) { skipNote(room, mb, true); d.idx = (d.idx + 1) % d.members.length; continue; }
    const prev = d.members[(d.idx - 1 + d.members.length) % d.members.length];
    await speak(mb, room, `\n当前是${prev.name}和你之间的专题讨论（第 ${d.round + 1}/${maxR} 轮）。请直接回应${prev.name}上一条观点，推进讨论或收敛结论。`, { mode: 'debate', round: d.round });
    d.idx = (d.idx + 1) % d.members.length;
    if (d.idx === 0) d.round++;
  }
  if (debates.get(room.id) === d) {
    debates.delete(room.id);
    addRec({ id: 's' + Date.now(), ts: Date.now(), room: room.id, kind: 'system', from: 'system', text: `（已达最大轮数 ${maxR}，讨论自动结束；想继续就再发一次「让X和Y讨论…」）`, meta: {} });
  }
}
function handleUser(roomId, text, attach) {
  const room = roomInfo(roomId);
  if (!room) return;
  addRec({ id: 'u' + Date.now(), ts: Date.now(), room: roomId, kind: 'user', from: '你', text, meta: {}, ...(attach ? { attach } : {}) });
  const histUpTo = log.length;                         // 本轮基线：独立模式下成员的历史切到这里为止
  if (!text) { /* 只有附件时不做人设/检索解析 */ }
  const personaNote = maybeSetPersona(text);
  if (personaNote) addRec({ id: 's' + Date.now(), ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: personaNote, meta: {} });
  if (/^(停|停止|停下|停一下|都停|别说了|stop)$/i.test(text.trim())) {
    const hadDebate = debates.has(roomId);
    debates.delete(roomId);
    cancelRoom(roomId);                                 // 中断正在生成的请求 + 阻止后续成员发言
    addRec({ id: 's' + Date.now(), ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: hadDebate ? '（专题讨论已停止）' : '（已停止本会话的后续发言）', meta: {} });
    return;
  }
  // 上一轮还没说完就又发了一条：先掐掉它，别让你的新话排在一堆旧发言后面干等。
  // （以前只有说「停」才中断，导致正生成的那条会一直说下去 —— 2026-10-19 用户报的）
  const rc = ctlOf(roomId);
  if (rc.jobs > 0 || rc.acs.size > 0) {
    cancelRoom(roomId, 'newmsg');                      // 互搏/多拍循环会自己看到 cancel 并收尾
    addRec({ id: 's' + Date.now() + 'int', ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: '（你发了新消息，上一轮被打断）', meta: { noHist: true } });
  }
  enqueue(roomId, async () => {
    const ctl0 = ctlOf(roomId);
    ctl0.cancel = false;                               // 复位中断开关（必须等轮到这条时才复位）
    ctl0.calls = 0; ctl0.paused = false; ctl0.who = null; ctl0.beat = null; ctl0.total = null;   // 新一轮：计数归零、解除暂停
    broadcast({ type: 'round', room: roomId, calls: 0, paused: false });
    await refreshNet();
    const recall = maybeRecall(text, roomId);
    if (room.kind === 'dm') {
      const mb = room.members[0];
      if (offlineFor(mb)) return skipNote(room, mb, true);
      if (noteDown(mb)) return skipNote(room, mb);
      return speak(mb, room, recall, { mode: 'dm' });
    }
    const d = debates.get(roomId);
    if (d) { d.round = 0; return; }                     // 辩论中插话：上下文已含新消息，继续轮转
    const debaters = parseDebate(text, room.members);
    if (debaters) {
      debates.set(roomId, { members: debaters, idx: 0, round: 0 });
      addRec({ id: 's' + Date.now(), ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: `（${debaters.map(d2 => d2.name).join(' ↔ ')} 专题讨论开始，最多 ${roundsFor(roomId)} 轮）`, meta: {} });
      return runDebate(room);
    }
    // 自由模式：不排班。一拍选一个发言人，说完把话头交出去，最多 autoBeats 拍。
    if (roomSettings[roomId]?.mode === 'flow') {
      await new Promise(r => setTimeout(r, 400));
      const beats = Math.max(1, Math.min(10, Number(roomSettings[roomId]?.autoBeats) || 3));
      if (room.members.length > 1) addRec({ id: 's' + Date.now() + 'flow', ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: `（自由模式：本轮最多 ${beats} 拍，谁开口看发言倾向，被点名的优先）`, meta: { noHist: true } });
      // 这句不能写成「接着上一句说」：那样每个人都会追着前一句打补丁，变成接力赛（用户实测反馈）
      const FLOW_TURN = '（轮到你在这个群里说句话。像发微信那样：一两句，别写小作文。可以接任何人的话，也可以换话题、翻旧账、只说半句；实在没什么想补的，就只回「沉默」两个字。）';
      let carry = text || '';                            // 上一句话，用来认「有人在点谁的名字」
      let lastId = null;
      const quiet = new Set();                           // 本轮已经表示"没话说"的人，别在同一轮反复点他
      for (let b = 0; b < beats; b++) {
        if (ctlOf(roomId).cancel) break;
        // 暂停 = 挂住等恢复（不是结束这一轮）；期间「继续接话」能接着走，发新消息或结束会打断
        while (ctlOf(roomId).paused && !ctlOf(roomId).cancel) { await new Promise(r => setTimeout(r, 300)); }
        if (ctlOf(roomId).cancel) break;
        const mb = pickSpeaker(room, carry, lastId, b === 0, quiet);   // 只有第一拍是「你」在点名
        if (!mb) break;
        const called = !!carry && carry.toLowerCase().includes(String(mb.name).toLowerCase());
        const extra = recall + (called ? '\n（上一条消息里喊了你的名字。）' : '');
        const rec = await speak(mb, room, extra, { mode: 'flow', beat: b + 1, total: beats, turnNote: FLOW_TURN });
        if (rec?.meta?.silent) { quiet.add(mb.id); }       // 没接话：本轮不再点他，话头留在上一句
        else if (rec?.text) carry = rec.text;
        lastId = mb.id;
        if (b < beats - 1) await new Promise(r => setTimeout(r, 500));
      }
      return;
    }

    const target = parseMention(text, room.members);
    if (target) {
      if (offlineFor(target)) return skipNote(room, target, true);
      if (noteDown(target)) return skipNote(room, target);
      return speak(target, room, recall, { mode: 'single' });
    }
    const off = room.members.filter(offlineFor);
    if (off.length) addRec({ id: 's' + Date.now(), ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: `（网络离线：${off.map(m => m.name).join('、')} 已跳过，仅本机 8B 可达）`, meta: {} });
    const names = room.members.map(m => m.name);
    const iso = roomSettings[roomId]?.mode === 'isolated';
    await new Promise(r => setTimeout(r, 400));           // 首棒前留个空档，等你的消息先落定

    if (iso) {
      // 独立模式：全员同时作答；每个人的历史都截到「用户这条消息」，互相看不到本轮答案。
      // 不传顺序提示（"上一位是谁、接着他说"），否则等于变相要求附和。
      const list = [];
      for (const mb of room.members) {
        if (offlineFor(mb)) { skipNote(room, mb, true); continue; }
        if (noteDown(mb)) { skipNote(room, mb); continue; }
        if (!isPresent(roomId, mb.id)) continue;          // 席外的人不参与
        list.push(mb);
      }
      if (ctlOf(roomId).cancel) return;
      if (room.members.length > 1) addRec({ id: 's' + Date.now() + 'iso', ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: '（独立模式：各成员同时作答，互相看不到对方的答案）', meta: { noHist: true } });
      const note = list.length > 1 ? '\n（本轮为独立作答：其他成员也在回答同一个问题，你看不到他们的答案。按自己的判断直接作答，不必与他们保持一致。）' : '';
      const total = list.length;
      await Promise.all(list.map((mb, i) => speak(mb, room, `${recall}${note}`, { mode: 'isolated', pos: i + 1, total }, histUpTo)));
      return;
    }

    for (let i = 0; i < room.members.length; i++) {
      const mb = room.members[i];
      if (ctlOf(roomId).cancel) break;                 // 用户喊停：后面的成员不再发言
      while (ctlOf(roomId).paused && !ctlOf(roomId).cancel) { await new Promise(r => setTimeout(r, 300)); }
      if (ctlOf(roomId).cancel) break;
      if (offlineFor(mb)) continue;
      if (noteDown(mb)) { skipNote(room, mb); continue; }
      if (!isPresent(roomId, mb.id)) continue;         // 席外的人不说话
      // 位置提示：让成员知道本轮顺序、自己第几个、前面是谁（解决"不知道自己在哪就交出空白卷"）
      const where = room.members.length > 1
        ? `\n【本轮顺序】${names.join(' → ')}。你是第 ${i + 1}/${room.members.length} 位` +
          (i === 0 ? '，本轮由你开场，先给出你的判断。' : `，上一位是 ${names[i - 1]}，接着他的话往下说。`)
        : '';
      if (i > 0) await new Promise(r => setTimeout(r, 700));   // 轮次间隔：让上一条落定，别和提示同时砸过来
      await speak(mb, room, `${recall}${where}`, { mode: 'roundtable', pos: i + 1, total: room.members.length });
    }
  });
}

// ---------- 兜底：崩了也要留下死因，而不是静悄悄消失 ----------
process.on('uncaughtException', (e) => {
  const msg = `[${new Date().toISOString()}] uncaughtException\n${e?.stack || e}\n\n`;
  try { mkdirSync(join(DATA, '..', 'logs'), { recursive: true }); writeFileSync(join(DATA, '..', 'logs', 'crash.log'), msg, { flag: 'a' }); } catch {}
  console.error('[uncaughtException]', e);
});
process.on('unhandledRejection', (e) => {
  const msg = `[${new Date().toISOString()}] unhandledRejection\n${e?.stack || e}\n\n`;
  try { mkdirSync(join(DATA, '..', 'logs'), { recursive: true }); writeFileSync(join(DATA, '..', 'logs', 'crash.log'), msg, { flag: 'a' }); } catch {}
  console.error('[unhandledRejection]', e);
});

// ---------- 圆桌议题（P1：开议题 / 独立准备 / 揭晓） ----------


// 设计：一个议题 = 一个特殊房间（roomId = "t:<id>"），消息照样进 room.jsonl；
//       议题自己的槽位存在 topics.json。规格见 docs/议题规格.md
const TOPICS_FILE = join(DATA, 'topics.json');
let topics = existsSync(TOPICS_FILE) ? JSON.parse(readFileSync(TOPICS_FILE, 'utf8')) : {};
const saveTopics = () => writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2), 'utf8');

const KIND_NAME = { review: '评审', candidates: '比稿', proposals: '方案比较' };

// 对外视图：**未揭晓前绝不返回候选正文**（互不可见靠这里兜底，不靠前端藏）
function publicTopic(t) {
  if (!t) return null;
  const open = Boolean(t.revealedAt) || ['discussing', 'conclusion', 'confirmed', 'ended'].includes(t.status);
  return {
    id: t.id, roomId: t.roomId, title: t.title, kind: t.kind, status: t.status,
    memberIds: t.memberIds, leadMemberId: t.leadMemberId, chooser: t.chooser,
    revealedAt: t.revealedAt || null, selectedSlotId: t.selectedSlotId || null,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    slots: (t.slots || []).map(s => ({
      memberId: s.memberId, status: s.status, at: s.at || null,
      ...(open ? { text: s.text || '', error: s.error || null } : {}),
    })),
    conclusion: t.conclusion || null,
  };
}
const topicOfRoom = (roomId) => (roomId && roomId.startsWith('t:') ? topics[roomId.slice(2)] : null);
const topicReady = (t) => t.slots.every(s => s.status === 'completed' || s.status === 'skipped');

// 单个成员的一句话作答：走和 speak 一样的模型通道，但**不写聊天记录、不广播**
async function askOnce(member, room, extra, turnNote) {
  const system = systemPrompt(member, room, extra);
  const budget = member.provider === LOCAL_PROVIDER ? Math.min(histFor(room.id), 3500) : undefined;
  const turns = [...recentTurns(room.id, budget), { role: 'user', content: turnNote }];
  const ac = new AbortController();
  const ctl = ctlOf(room.id); ctl.acs.add(ac);
  const signal = AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(180_000), ac.signal]) : ac.signal;
  let text = '';
  try {
    const run = async () => { for await (const chunk of askMember(member, system, turns, signal)) text += chunk; };
    await (member.provider === LOCAL_PROVIDER ? localLock(run) : run());
  } finally { ctl.acs.delete(ac); }
  return stripPrefix(text).trim();
}

function topicTurnNote(t) {
  const head = {
    review: '请你**独立评审**下面的材料：指出问题、风险和需要修改的地方。',
    candidates: '请你**独立写一版**方案/稿子，直接给成品，不要评论别人。',
    proposals: '请你**独立提出一个方案**：说清做法、代价和适用条件。',
  }[t.kind] || '请独立作答。';
  return `${head}
其他成员也在做同一件事，但你们彼此看不到对方的产出，公开前互不分享。
要求：中文；直接给内容，不要复述材料；不要写"作为 AI"这类开头；不超过 600 字。`;
}

async function runTopicPreparation(topic, room) {
  topic.status = 'reviewing'; topic.updatedAt = Date.now(); saveTopics();
  broadcast({ type: 'topic', topic: publicTopic(topic) });
  await Promise.all(topic.slots.map(async (slot) => {
    const mb = memberById(slot.memberId);
    if (!mb) { slot.status = 'skipped'; slot.error = '成员不存在'; return; }
    slot.status = 'running'; saveTopics(); broadcast({ type: 'topic', topic: publicTopic(topic) });
    try {
      const text = await askOnce(mb, room, '', topicTurnNote(topic));
      if (text) { slot.text = text; slot.status = 'completed'; } else { slot.status = 'skipped'; slot.error = '返回空内容'; }
    } catch (e) {
      slot.status = 'skipped'; slot.error = e.message;
    }
    slot.at = Date.now(); saveTopics(); broadcast({ type: 'topic', topic: publicTopic(topic) });
  }));
  topic.updatedAt = Date.now(); saveTopics();
  broadcast({ type: 'topic', topic: publicTopic(topic) });
  if (topicReady(topic)) addRec({ id: 's' + Date.now() + 'tr', ts: Date.now(), room: topic.roomId, kind: 'system', from: 'system', text: `（独立准备完成：${topic.slots.filter(s => s.status === 'completed').length}/${topic.slots.length} 份。可以揭晓了）`, meta: {} });
}

// 五段式纪要（结构照 AIROOM 的 minutesInstruction）
function buildMinutesPrompt(t, done) {
  const name = (id) => memberById(id)?.name || id;
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…（已截断）' : s);
  const pieces = done.map(s => `【${name(s.memberId)}】\n${cut(s.text || '', 2500)}`).join('\n\n');
  const sel = done.find(s => s.memberId === t.selectedSlotId);
  const talk = log.filter(r => r.room === t.roomId && r.kind === 'member' && !r.meta?.conclusion && !r.meta?.revealed)
    .slice(-12).map(r => `${r.from}：${cut(r.text || '', 300)}`).join('\n');
  return `这是圆桌议题「${t.title}」（类型：${KIND_NAME[t.kind] || t.kind}）的整理任务。请只用中文写纪要。

材料：
${cut(t.material?.text || '', 1500)}

各成员独立产出的版本（公开前互不可见）：
${pieces}

${sel ? `用户已选用：${name(sel.memberId)} 的版本。` : '用户尚未选稿。'}
${talk ? `\n揭晓之后的讨论记录：\n${talk}` : ''}

请严格按下面五段输出，每段必须有标题：
## 共识
## 分歧与各方理由
## 少数意见
## 未核实事项
## 建议

要求：
- 没有明确记录的内容写"未形成"或"未记录"，不要编。
- 不能把某一个人的建议或多数意见写成"全员共识"。
- 用户已选用的版本以记录为准，不能自行改变或替换。
- 不要出现内部编号、字段名、英文缩写。
- 直接给纪要正文，不要开场白和结尾客套。`;
}
// ---------- HTTP ----------
const HTML = readFileSync(join(ROOT, 'public', 'index.html'));
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' }); return res.end(HTML); }
  if (u.pathname === '/api/state' && req.method === 'GET') {
    return json(res, { members, rooms, maxRounds: MAX_ROUNDS, states: mstate, netOnline, settings: roomSettings, histDefault: HIST_CHARS, appTitle: roomSettings._app?.title || '圆桌', theme: roomSettings._app?.theme || null, addressing: roomSettings._app?.addressing || 'MD', topics: Object.values(topics).map(publicTopic) });
  }
  if (u.pathname === '/api/messages' && req.method === 'GET') {
    const room = u.searchParams.get('room') || 'free';
    return json(res, { messages: log.filter(r => r.room === room).slice(-80) });
  }
  if (u.pathname === '/api/upload' && req.method === 'POST') {   // ＋ → 图片/视频/文件
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', c => { size += c.length; if (size > 30 * 1024 * 1024) tooBig = true; else chunks.push(c); });
    req.on('end', async () => {
      if (tooBig) return json(res, { ok: false, error: '请求体超过 30MB' });
      try {
        const { name, mime, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const buf = Buffer.from(String(data || ''), 'base64');
        if (!buf.length) return json(res, { ok: false, error: '空文件' });
        if (buf.length > 20 * 1024 * 1024) return json(res, { ok: false, error: '文件超过 20MB' });
        mkdirSync(UPLOAD_DIR, { recursive: true });
        const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-60);
        const fn = Date.now().toString(36) + '-' + safe;
        writeFileSync(join(UPLOAD_DIR, fn), buf);
        const attach = { url: '/uploads/' + encodeURIComponent(fn), name: safe, mime: mime || '', size: buf.length };
        await enrichAttach(attach, buf, safe);        // 文本读正文 / 图片转描述，供模型阅读
        json(res, { ok: true, ...attach });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname.startsWith('/uploads/') && req.method === 'GET') {
    try {
      const fn = decodeURIComponent(u.pathname.slice('/uploads/'.length));
      const p = join(UPLOAD_DIR, fn);
      if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
      const ext = fn.split('.').pop().toLowerCase();
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json' };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      res.end(readFileSync(p));
    } catch { res.writeHead(500); res.end('err'); }
    return;
  }
  if (u.pathname === '/api/send' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { try { const { room, text, attach } = JSON.parse(body); if ((text && text.trim()) || attach) handleUser(room || 'free', (text || '').trim(), attach); } catch {} json(res, {}); });
    return;
  }
  if (u.pathname === '/api/backup/import' && req.method === 'POST') {   // 设置 → 导入备份
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { target, sources } = JSON.parse(body);
        const room = roomInfo(target);
        if (!room) return json(res, { ok: false, error: '目标会话不存在' });
        let count = 0;
        const base = Date.now();
        for (const src of (Array.isArray(sources) ? sources : [])) {
          const srcName = src.name || '备份';
          const msgs = Array.isArray(src.messages) ? src.messages : [];
          if (!msgs.length) continue;
          addRec({ id: 's' + base + Math.random().toString(36).slice(2, 5), ts: Date.now(), room: target, kind: 'system', from: 'system', text: `（导入备份：「${srcName}」共 ${msgs.length} 条，以下是导入内容）`, meta: { imported: msgs.length } });
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const rec = {
              id: 'i' + base.toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 4),
              ts: m.ts || Date.now(), room: target, kind: m.kind || 'user', from: m.from || '你',
              text: m.text || '', meta: { ...(m.meta || {}), importedFrom: srcName },
            };
            if (m.forward) rec.forward = m.forward;
            log.push(rec); count++;
          }
          addRec({ id: 's' + (base + 1) + Math.random().toString(36).slice(2, 5), ts: Date.now(), room: target, kind: 'system', from: 'system', text: `（导入结束，共 ${count} 条）`, meta: {} });
        }
        flushLog();
        broadcast({ type: 'imported', room: target, count });
        json(res, { ok: true, count });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/backup/default' && req.method === 'GET') {
    return json(res, { dir: join(ROOT, 'backups') });
  }
  if (u.pathname === '/api/backup' && req.method === 'POST') {   // 设置 → 历史备份（导出到任意路径）
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { rooms: want, dir } = JSON.parse(body);
        const target = (dir || '').trim() || join(ROOT, 'backups');
        mkdirSync(target, { recursive: true });
        const ids = (Array.isArray(want) && want.length) ? want : Object.keys(rooms);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const out = { exportedAt: new Date().toISOString(), rooms: {} };
        for (const id of ids) {
          const info = roomInfo(id);
          if (!info) continue;
          out.rooms[id] = { name: info.name, kind: info.kind, members: info.members.map(m => m.name), messages: log.filter(r => r.room === id) };
        }
        const jsonFile = join(target, `圆桌备份-${stamp}.json`);
        writeFileSync(jsonFile, JSON.stringify(out, null, 2), 'utf8');
        let mdCount = 0;
        for (const [id, r] of Object.entries(out.rooms)) {       // 同时给一份人能直接读的 Markdown
          const safe = r.name.replace(/[\\/:*?"<>|]/g, '_');
          const md = [`# ${r.name}`, `导出时间：${out.exportedAt}`, `成员：${r.members.join('、')}`, '']
            .concat(r.messages.map(m => {
              const t = new Date(m.ts).toLocaleString('zh-CN');
              const who = m.kind === 'user' ? '你' : m.kind === 'system' ? '〔系统〕' : m.from;
              const body2 = m.kind === 'forward'
                ? `${m.text ? m.text + '\n' : ''}` + (m.forward?.items || []).map(it => `  > 转发自 ${it.chain.map(roomLabelOf).join(' → ')}｜${it.from}：${it.text}`).join('\n')
                : m.text;
              return `**${who}** · ${t}\n\n${body2}\n`;
            })).join('\n');
          writeFileSync(join(target, `${safe}.md`), md, 'utf8'); mdCount++;
        }
        json(res, { ok: true, file: jsonFile, dir: target, rooms: Object.keys(out.rooms).length, md: mdCount });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/rooms/order' && req.method === 'POST') {     // 设置 → 发言人顺序
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, order } = JSON.parse(body);
        const r = rooms[room];
        if (!r) return json(res, { ok: false, error: '群不存在' });
        const want = (Array.isArray(order) ? order : []).filter(x => r.members.includes(x));
        if (want.length !== r.members.length || new Set(want).size !== r.members.length) return json(res, { ok: false, error: '成员列表不匹配' });
        const before = [...r.members];
        const changed = before.length !== want.length || before.some((x, i) => x !== want[i]);
        r.members = want; saveRooms(); broadcast({ type: 'rooms', rooms });
        if (changed) {                                   // 留痕：让群成员知道顺序变了
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          const names = want.map(id => memberById(id)?.name ?? id);
          addRec({ id: 's' + Date.now(), ts: Date.now(), room, kind: 'system', from: 'system', text: `（${t} 用户调整了本群发言顺序：${names.join(' → ')}）`, meta: { order: want } });
        }
        json(res, { ok: true, order: r.members });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/app-theme' && req.method === 'POST') {   // 背景色 / 图案
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { theme } = JSON.parse(body);
        const t = theme || {};
        const clean = {
          dark: t.dark !== false,
          gradient: !!t.gradient,
          color: /^#[0-9a-fA-F]{6}$/.test(String(t.color || '')) ? t.color : '#f3f4f6',
          pattern: ['none', 'dots', 'grid', 'diag'].includes(t.pattern) ? t.pattern : 'none',
          image: /^\/uploads\/[\w.\-%]+$/.test(String(t.image || '')) ? t.image : '',
        };
        roomSettings._app = { ...(roomSettings._app || {}), theme: clean };
        saveSettings();
        broadcast({ type: 'theme', theme: clean });
        json(res, { ok: true, theme: clean });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/app-title' && req.method === 'POST') {   // 左上角标题重命名
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { title } = JSON.parse(body);
        const t = String(title || '').trim().slice(0, 20);
        if (!t) return json(res, { ok: false, error: '标题不能为空' });
        roomSettings._app = { ...(roomSettings._app || {}), title: t };
        saveSettings();
        broadcast({ type: 'app', title: t });
        json(res, { ok: true, title: t });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/room-settings' && req.method === 'POST') {   // 聊天窗口＋ → 设置（上下文/模式/人设）
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, histChars, mode, personas, maxRounds, autoBeats, talkativeness, present } = JSON.parse(body);
        if (!roomInfo(room)) return json(res, { ok: false, error: '会话不存在' });
        const cur = roomSettings[room] || {};
        const next = { ...cur };
        if (histChars !== undefined) {
          const v = Number(histChars);
          if (!Number.isFinite(v) || v < 500 || v > 400_000) return json(res, { ok: false, error: '数值需在 500 ~ 400000 之间' });
          next.histChars = Math.round(v);
        }
        if (mode !== undefined) {
          if (!['free', 'persona', 'isolated', 'flow'].includes(mode)) return json(res, { ok: false, error: '模式不合法' });
          next.mode = mode;
        }
        if (autoBeats !== undefined) {
          const v = Number(autoBeats);
          if (!Number.isFinite(v) || v < 1 || v > 10) return json(res, { ok: false, error: '自动续拍需在 1 ~ 10 之间' });
          next.autoBeats = Math.round(v);
        }
        if (talkativeness && typeof talkativeness === 'object') {
          const clean = {};
          for (const [id, val] of Object.entries(talkativeness)) {
            if (!memberById(id)) continue;
            const v = Number(val);
            if (Number.isFinite(v)) clean[id] = Math.max(0, Math.min(100, Math.round(v)));
          }
          next.talkativeness = clean;
        }
        if (present && typeof present === 'object') {   // 在场：false = 本轮放到席外
          const clean = {};
          for (const [id, val] of Object.entries(present)) {
            if (memberById(id)) clean[id] = val !== false;
          }
          next.present = clean;
        }
        if (maxRounds !== undefined) {
          const r = Number(maxRounds);
          if (!Number.isFinite(r) || r < 1 || r > 50) return json(res, { ok: false, error: '最大轮数需在 1 ~ 50 之间' });
          next.maxRounds = Math.round(r);
        }
        if (personas && typeof personas === 'object') {
          const clean = {};
          for (const [id, txt] of Object.entries(personas)) {
            const t = String(txt || '').trim().slice(0, 300);
            if (t && memberById(id)) clean[id] = t;      // 留空即删除该成员的本会话来设定
          }
          next.personas = clean;
        }
        roomSettings[room] = next;
        saveSettings();
        json(res, { ok: true, settings: next });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  // ---------- 议题 API（P1） ----------
  if (u.pathname === '/api/topic/open' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { title, kind, material, memberIds, leadMemberId, chooser } = JSON.parse(body);
        const k = ['review', 'candidates', 'proposals'].includes(kind) ? kind : 'review';
        const mat = String(material || '').trim().slice(0, 100000);
        const ids = Array.isArray(memberIds) ? memberIds.filter(id => memberById(id)) : [];
        if (!ids.length) return json(res, { ok: false, error: '请至少选择一位成员' });
        if (new Set(ids).size !== ids.length) return json(res, { ok: false, error: '成员重复' });
        if (!mat) return json(res, { ok: false, error: '请填写材料' });
        const lead = memberById(leadMemberId) ? leadMemberId : ids[0];
        const id = 't' + Date.now().toString(36);
        const roomId = 't:' + id;
        const tt = String(title || '').trim().slice(0, 24) || (KIND_NAME[k] + '：' + (mat.split('\n')[0] || '').slice(0, 16));
        rooms[roomId] = { name: tt, members: ids, topic: id };
        saveRooms();
        const topic = {
          id, roomId, title: tt, kind: k, status: 'preparing', material: { text: mat },
          memberIds: ids, leadMemberId: lead, chooser: chooser === 'synthesizer' ? 'synthesizer' : 'user',
          slots: ids.map(mid => ({ memberId: mid, status: 'queued', text: '' })),
          revealedAt: null, selectedSlotId: null, conclusion: null,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        topics[id] = topic; saveTopics();
        addRec({ id: 'u' + Date.now(), ts: Date.now(), room: roomId, kind: 'user', from: '你', text: mat, meta: { topicMaterial: true } });
        addRec({ id: 's' + Date.now() + 't', ts: Date.now(), room: roomId, kind: 'system', from: 'system', text: `（${KIND_NAME[k]}议题「${tt}」：${ids.length} 位成员各自独立准备，公开前互不可见）`, meta: {} });
        broadcast({ type: 'rooms', rooms });
        broadcast({ type: 'topic', topic: publicTopic(topic) });
        json(res, { ok: true, topic: publicTopic(topic) });
        runTopicPreparation(topic, roomInfo(roomId)).catch(e => {
          topic.status = 'blocked'; saveTopics();
          broadcast({ type: 'topic', topic: publicTopic(topic) });
          console.error('[topic]', e.message);
        });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/topic/reveal' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { topicId } = JSON.parse(body);
        const t = topics[topicId];
        if (!t) return json(res, { ok: false, error: '议题不存在' });
        if (t.revealedAt) return json(res, { ok: false, error: '已经揭晓过了' });
        if (!topicReady(t)) return json(res, { ok: false, error: '还有成员在准备，等全部完成再揭晓' });
        let n = 0;
        for (const slot of t.slots) {
          if (slot.status !== 'completed') continue;
          const mb = memberById(slot.memberId);
          addRec({
            id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), ts: Date.now(), room: t.roomId,
            kind: 'member', from: mb?.name || slot.memberId, text: slot.text,
            meta: { topicId: t.id, slotId: slot.memberId, revealed: true },
          });
          n++;
        }
        t.revealedAt = Date.now(); t.status = 'discussing'; t.updatedAt = Date.now(); saveTopics();
        addRec({ id: 's' + Date.now() + 'rv', ts: Date.now(), room: t.roomId, kind: 'system', from: 'system', text: `（已揭晓 ${n} 份，可以开始讨论了）`, meta: {} });
        broadcast({ type: 'topic', topic: publicTopic(t) });
        json(res, { ok: true, topic: publicTopic(t) });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  // 删除议题（含它的房间与消息）。孤儿议题（房间已被删）也走这里清理。
  if (u.pathname === '/api/topic/delete' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { topicId } = JSON.parse(body);
        const t5 = topics[topicId];
        if (!t5) return json(res, { ok: false, error: '议题不存在' });
        delete topics[topicId]; saveTopics();
        if (rooms[t5.roomId]) { delete rooms[t5.roomId]; saveRooms(); broadcast({ type: 'rooms', rooms }); }
        for (let i = log.length - 1; i >= 0; i--) if (log[i].room === t5.roomId) log.splice(i, 1);
        flushLog();
        broadcast({ type: 'topic-deleted', id: topicId });
        json(res, { ok: true });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }  if (u.pathname === '/api/topic/select' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { topicId, slotId } = JSON.parse(body);
        const t2 = topics[topicId];
        if (!t2) return json(res, { ok: false, error: '议题不存在' });
        if (!t2.revealedAt) return json(res, { ok: false, error: '还没揭晓，不能选用' });
        const slot = t2.slots.find(s => s.memberId === slotId);
        if (!slot || slot.status !== 'completed') return json(res, { ok: false, error: '这份稿子不可选' });
        t2.selectedSlotId = slotId; t2.updatedAt = Date.now(); saveTopics();
        const mb = memberById(slotId);
        addRec({ id: 's' + Date.now() + 'sel', ts: Date.now(), room: t2.roomId, kind: 'system', from: 'system', text: `（已采用 ${mb?.name || slotId} 的版本。仅是选择标记，不代表验收通过或全员共识）`, meta: { noHist: true } });
        broadcast({ type: 'topic', topic: publicTopic(t2) });
        json(res, { ok: true, topic: publicTopic(t2) });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }  if (u.pathname === '/api/topic/conclude' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { topicId } = JSON.parse(body);
        const t3 = topics[topicId];
        if (!t3) return json(res, { ok: false, error: '议题不存在' });
        if (!t3.revealedAt) return json(res, { ok: false, error: '还没揭晓' });
        if (t3.status === 'summarizing') return json(res, { ok: false, error: '正在整理中' });
        if (['confirmed', 'ended'].includes(t3.status)) return json(res, { ok: false, error: '议题已结束' });
        const done = t3.slots.filter(s => s.status === 'completed');
        if (!done.length) return json(res, { ok: false, error: '没有可整理的稿子' });
        t3.status = 'summarizing'; t3.updatedAt = Date.now(); saveTopics();
        broadcast({ type: 'topic', topic: publicTopic(t3) });
        json(res, { ok: true, topic: publicTopic(t3) });
        const lead = memberById(t3.leadMemberId) || memberById(done[0].memberId);
        const room = roomInfo(t3.roomId);
        (async () => {
          try {
            const text = await askOnce(lead, room, '', buildMinutesPrompt(t3, done));
            t3.conclusion = { text, at: Date.now(), by: lead.name };
            t3.status = 'conclusion'; t3.updatedAt = Date.now(); saveTopics();
            addRec({ id: 'm' + Date.now() + 'cc', ts: Date.now(), room: t3.roomId, kind: 'member', from: lead.name, text, meta: { topicId: t3.id, conclusion: true } });
            addRec({ id: 's' + Date.now() + 'cc', ts: Date.now(), room: t3.roomId, kind: 'system', from: 'system', text: '（纪要已整理，等你确认）', meta: { noHist: true } });
            broadcast({ type: 'topic', topic: publicTopic(t3) });
          } catch (e) {
            t3.status = 'discussing'; t3.updatedAt = Date.now(); saveTopics();
            addRec({ id: 's' + Date.now() + 'ce', ts: Date.now(), room: t3.roomId, kind: 'system', from: 'system', text: `（整理结论失败：${e.message}）`, meta: {} });
            broadcast({ type: 'topic', topic: publicTopic(t3) });
          }
        })();
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/topic/confirm' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { topicId, action } = JSON.parse(body);
        const t4 = topics[topicId];
        if (!t4) return json(res, { ok: false, error: '议题不存在' });
        const note = (s) => addRec({ id: 's' + Date.now() + 'cf', ts: Date.now(), room: t4.roomId, kind: 'system', from: 'system', text: s, meta: { noHist: true } });
        if (action === 'confirm') {
          if (!t4.conclusion) return json(res, { ok: false, error: '还没有纪要' });
          t4.status = 'confirmed'; note('（结论已确认）');
        } else if (action === 'reopen') {
          t4.status = 'discussing'; t4.conclusion = null; note('（要求再议一轮，可以继续说）');
        } else if (action === 'end') {
          t4.status = 'ended'; note('（议题已结束，记录保留）');
        } else return json(res, { ok: false, error: '未知操作' });
        t4.updatedAt = Date.now(); saveTopics();
        broadcast({ type: 'topic', topic: publicTopic(t4) });
        json(res, { ok: true, topic: publicTopic(t4) });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }  if (u.pathname === '/api/app-addressing' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { addressing } = JSON.parse(body);
        const v = String(addressing || '').trim().slice(0, 20) || 'MD';
        roomSettings._app = { ...(roomSettings._app || {}), addressing: v };
        saveSettings();
        json(res, { ok: true, addressing: v });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  // 暂停接话：当前这句说完就停起新的，但这一轮不作废（和「结束讨论」区分开）
  if (u.pathname === '/api/room-pause' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, paused } = JSON.parse(body);
        if (!roomInfo(room)) return json(res, { ok: false, error: '会话不存在' });
        const c = ctlOf(room);
        c.paused = !!paused;
        broadcast({ type: 'round', room, calls: c.calls || 0, paused: c.paused });
        json(res, { ok: true, paused: c.paused });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  // 结束讨论：掐断正在飞的、剩下的不再起（等于对当前会话喊「停」，但不往聊天里插一条消息）
  if (u.pathname === '/api/room-stop' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room } = JSON.parse(body);
        if (!roomInfo(room)) return json(res, { ok: false, error: '会话不存在' });
        cancelRoom(room, 'stop');
        broadcast({ type: 'round', room, calls: ctlOf(room).calls || 0, paused: false });
        json(res, { ok: true });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/rooms/rename' && req.method === 'POST') {   // 群名右键 → 重命名
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, name } = JSON.parse(body);
        const nm = String(name || '').trim();
        if (!rooms[room] || !nm) return json(res, { ok: false, error: '参数不合法' });
        rooms[room].name = nm.slice(0, 20); saveRooms(); broadcast({ type: 'rooms', rooms });
        json(res, { ok: true });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/rooms/pin' && req.method === 'POST') {      // 群名右键 → 置顶
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, pinned } = JSON.parse(body);
        if (!rooms[room]) return json(res, { ok: false, error: '群不存在' });
        rooms[room].pinned = !!pinned; saveRooms(); broadcast({ type: 'rooms', rooms });
        json(res, { ok: true });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/messages/delete' && req.method === 'POST') {   // 勾选删除若干条消息
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, ids } = JSON.parse(body);
        const set = new Set(ids || []);
        let firstIdx = -1, removed = 0;
        for (let i = 0; i < log.length; i++) if (log[i].room === room && set.has(log[i].id)) { if (firstIdx < 0) firstIdx = i; removed++; }
        let notice = null;
        if (removed > 0) {
          for (let i = log.length - 1; i >= 0; i--) if (log[i].room === room && set.has(log[i].id)) log.splice(i, 1);
          const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          notice = { id: 's' + Date.now(), ts: Date.now(), room, kind: 'system', from: 'system', text: `（${t} 用户在此处删除了 ${removed} 条消息，上下文有缺失；不要臆测被删内容）`, meta: { deleted: removed } };
          log.splice(Math.min(firstIdx, log.length), 0, notice);   // 插回被删位置，替代那几条
          flushLog();
        }
        broadcast({ type: 'deleted', room, ids: [...set], notice });
        json(res, { ok: true, removed });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/search' && req.method === 'GET') {   // ＋ → 搜索（跨所有会话）
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return json(res, { hits: [] });
    const hits = log.filter(r => r.text && r.text.includes(q)).slice(-60).map(r => ({
      id: r.id, room: r.room, roomName: roomLabelOf(r.room), from: r.from, kind: r.kind, ts: r.ts, text: r.text,
    }));
    return json(res, { hits });
  }
  if (u.pathname === '/api/rooms/clear' && req.method === 'POST') {   // ＋ → 删除对话（清空该会话记录）
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, deleteRoom } = JSON.parse(body);
        // 允许清理"孤儿记录"：房间或成员已删除，但聊天记录还在（dm: 与已删群都属于这种）
        if (!roomInfo(room) && !room.startsWith('dm:') && !rooms[room]) {
          const had = log.some(r => r.room === room);
          if (!had) return json(res, { ok: false, error: '会话不存在' });
        }
        const before = log.length;
        for (let i = log.length - 1; i >= 0; i--) if (log[i].room === room) log.splice(i, 1);
        if (deleteRoom && !['work', 'free'].includes(room) && rooms[room]) { delete rooms[room]; saveRooms(); broadcast({ type: 'rooms', rooms }); }
        flushLog();
        broadcast({ type: 'cleared', room, deleted: !!deleteRoom });
        json(res, { ok: true, removed: before - log.length });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/catalog' && req.method === 'GET') {
    return json(res, { catalog: CATALOG });
  }
  if (u.pathname === '/api/rooms/create' && req.method === 'POST') {   // ＋ → 新建群聊
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let out = { ok: false };
      try {
        const { name, members: mem } = JSON.parse(body);
        const nm = String(name || '').trim();
        if (nm) {
          const id = 'g' + Date.now().toString(36);
          rooms[id] = { name: nm.slice(0, 20), members: (Array.isArray(mem) ? mem : []).filter(x => memberById(x)) };
          saveRooms(); broadcast({ type: 'rooms', rooms });
          addRec({ id: 's' + Date.now(), ts: Date.now(), room: id, kind: 'system', from: 'system', text: `（群聊「${rooms[id].name}」已创建）`, meta: {} });
          out = { ok: true, id };
        }
      } catch (e) { out = { ok: false, error: e.message }; }
      json(res, out);
    });
    return;
  }
  if (u.pathname === '/api/members/remove' && req.method === 'POST') {   // ＋ → 删除模型（连同从所有群里移除）
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const i = members.findIndex(m => m.id === id);
        if (i < 0) return json(res, { ok: false, error: '成员不存在' });
        const [mb] = members.splice(i, 1);
        saveMembers();
        for (const k of Object.keys(rooms)) {
          const set = new Set(rooms[k].members); set.delete(id); rooms[k].members = [...set];
        }
        saveRooms();
        broadcast({ type: 'members', members });
        broadcast({ type: 'rooms', rooms });
        json(res, { ok: true, removed: mb.name });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  // 个人资料：名字 / 头像表情 / 人设（全局）/ 线路+模型
  if (u.pathname === '/api/members/update' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, name, emoji, persona, provider, model, avatar, portrait, tagline, color, portraitZoom, portraitX, portraitY, talk, acts, relations, routine, gender, age, outfit, role } = JSON.parse(body);
        const mb = members.find(m => m.id === id);
        if (!mb) return json(res, { ok: false, error: '成员不存在' });
        if (name !== undefined) {
          const nm = String(name).trim().slice(0, 20);
          if (!nm) return json(res, { ok: false, error: '名字不能为空' });
          mb.name = nm;
        }
        if (emoji !== undefined) mb.emoji = String(emoji).trim().slice(0, 4);
        if (persona !== undefined) {
          const p = String(persona).trim().slice(0, 300);
          if (p) mb.persona = p; else delete mb.persona;
        }
        if (avatar !== undefined) {
          const a = String(avatar).trim();
          if (/^\/uploads\/[\w.\-%]+$/.test(a)) mb.avatar = a; else delete mb.avatar;
        }
        if (portrait !== undefined) {
          const p2 = String(portrait).trim();
          if (/^\/uploads\/[\w.\-%]+$/.test(p2)) mb.portrait = p2; else delete mb.portrait;
        }
        if (portraitZoom !== undefined) {
          const z = Number(portraitZoom);
          if (Number.isFinite(z)) mb.portraitZoom = Math.max(0.5, Math.min(4, z));
        }
        if (portraitX !== undefined) { const x = Number(portraitX); if (Number.isFinite(x)) mb.portraitX = Math.round(x); }
        if (portraitY !== undefined) { const y = Number(portraitY); if (Number.isFinite(y)) mb.portraitY = Math.round(y); }
        if (gender !== undefined) { const g = String(gender || '').trim().slice(0, 6); if (g) mb.gender = g; else delete mb.gender; }
        if (age !== undefined) { const a = Number(age); if (Number.isFinite(a) && a > 0 && a < 999) mb.age = Math.round(a); else delete mb.age; }
        if (outfit !== undefined) { const s = String(outfit || '').trim().slice(0, 40); if (s) mb.outfit = s; else delete mb.outfit; }
        if (role !== undefined) { const s = String(role || '').trim().slice(0, 30); if (s) mb.role = s; else delete mb.role; }
        if (talk !== undefined) { const n = Number(talk); if (Number.isFinite(n)) mb.talk = Math.max(0, Math.min(100, Math.round(n))); }
        if (acts !== undefined) {
          const arr = Array.isArray(acts) ? acts.map(x => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 8) : [];
          if (arr.length) mb.acts = arr; else delete mb.acts;
        }
        if (relations !== undefined && relations && typeof relations === 'object') {
          const rel = {};
          for (const [k, v] of Object.entries(relations)) {
            const s = String(v || '').trim().slice(0, 40);
            if (s && memberById(k)) rel[k] = s;
          }
          if (Object.keys(rel).length) mb.relations = rel; else delete mb.relations;
        }
        if (routine !== undefined && routine && typeof routine === 'object') {
          const rt = {};
          for (const k of ['morning', 'day', 'evening', 'night']) {
            const s = String(routine[k] || '').trim().slice(0, 30);
            if (s) rt[k] = s;
          }
          if (Object.keys(rt).length) mb.routine = rt; else delete mb.routine;
        }
        if (tagline !== undefined) {
          const tg = String(tagline).trim().slice(0, 40);
          if (tg) mb.tagline = tg; else delete mb.tagline;
        }
        if (color !== undefined) {
          const c2 = String(color).trim();
          if (/^#[0-9a-fA-F]{6}$/.test(c2)) mb.color = c2; else delete mb.color;
        }
        if (provider !== undefined && model !== undefined) {
          const p = String(provider), mo = String(model).trim();
          if (!ROUTES[p]) return json(res, { ok: false, error: '线路不合法' });
          if (!mo) return json(res, { ok: false, error: '模型不能为空' });   // 2026-10-20 踩过：下拉没选项时空值被写进去，成员就废了
          mb.provider = p; mb.model = mo;
        }
        saveMembers();
        broadcast({ type: 'members', members });
        json(res, { ok: true, member: mb });
      } catch (e) { json(res, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u.pathname === '/api/members/add' && req.method === 'POST') {    // ＋ → 添加模型
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let out = { ok: false };
      try {
        const { name, provider, model } = JSON.parse(body);
        const nm = String(name || '').trim();
        if (!nm || !ROUTES[provider]) return json(res, { ok: false, error: '名字或 provider 不合法' });
        if (members.some(m => m.name === nm)) return json(res, { ok: false, error: '已存在同名成员' });
        const mb = { id: 'u' + Date.now().toString(36), name: nm.slice(0, 12), provider, model: String(model || CATALOG[provider]?.[0] || ''), persona: null };
        members.push(mb); saveMembers();
        broadcast({ type: 'members', members });
        out = { ok: true, member: mb };
      } catch (e) { out = { ok: false, error: e.message }; }
      json(res, out);
    });
    return;
  }
  if (u.pathname === '/api/forward' && req.method === 'POST') {   // 用户勾选消息 → 转发到任意会话（带评论、带链路）
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let out = { ok: false };
      try {
        const { sourceRoom, ids, targets, comment } = JSON.parse(body);
        const recs = log.filter(r => (ids || []).includes(r.id));
        if (recs.length && Array.isArray(targets) && targets.length) {
          const items = recs.flatMap(r => flattenForward(r, sourceRoom));
          let n = 0;
          for (const t of targets) {
            if (!roomInfo(t)) continue;
            addRec({ id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6), ts: Date.now(), room: t, kind: 'forward', from: '你', text: (comment || '').trim(), forward: { comment: (comment || '').trim(), items }, meta: { source: sourceRoom } });
            n++;
          }
          out = { ok: true, forwarded: n, items: items.length };
        }
      } catch (e) { out = { ok: false, error: e.message }; }
      json(res, out);
    });
    return;
  }
  if (u.pathname === '/api/rooms' && req.method === 'POST') {   // 右键：加入/移出工作或自由模式
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { room, memberId, op } = JSON.parse(body);
        if (rooms[room] && memberById(memberId)) {
          const set = new Set(rooms[room].members);
          op === 'remove' ? set.delete(memberId) : set.add(memberId);
          rooms[room].members = [...set];
          saveRooms();
          broadcast({ type: 'rooms', rooms });
          addRec({ id: 's' + Date.now(), ts: Date.now(), room, kind: 'system', from: 'system', text: `（${memberById(memberId).name} 已${op === 'remove' ? '移出' : '加入'}${rooms[room].name}）`, meta: {} });
        }
      } catch {}
      json(res, { rooms });
    });
    return;
  }
  if (u.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res); req.on('close', () => sseClients.delete(res));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? `http://127.0.0.1:${PORT}（已开放局域网，同网段可用本机 IP 访问）` : `http://${HOST}:${PORT}`;
  console.log(`[圆桌 v3] ${shown}  max-rounds=${MAX_ROUNDS}  members=${members.length}  rooms=${GROUP_IDS.join('/')}`);
});
