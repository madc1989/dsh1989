// test-sse.mjs -- 抓一次真实发言的 SSE 事件序列，验证没有重复/空气泡、end 带全文
const base = 'http://127.0.0.1:3000';
const room = process.argv[2] || 'dm:ds';
const text = process.argv[3] || '只回复两个字：OK';

const res = await fetch(base + '/api/events');
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
setTimeout(() => {
  fetch(base + '/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, text }) });
}, 400);

const t0 = Date.now();
const deadline = 90_000;
let sawEnd = false;
while (Date.now() - t0 < deadline) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    if (!line) continue;
    const ev = JSON.parse(line.slice(6));
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (ev.type === 'msg') console.log(`[${t}s] msg      kind=${ev.rec.kind} room=${ev.rec.room} len=${ev.rec.text.length}`);
    else if (ev.type === 'start') console.log(`[${t}s] start    from=${ev.from} room=${ev.room}`);
    else if (ev.type === 'delta') { /* 流式片段不打印，太多 */ }
    else if (ev.type === 'end') { console.log(`[${t}s] end      room=${ev.room} finalLen=${ev.rec?.text.length} text="${(ev.rec?.text || '').slice(0, 40)}"`); sawEnd = true; }
    else console.log(`[${t}s] ${ev.type}  ${JSON.stringify(ev).slice(0, 80)}`);
    if (sawEnd) process.exit(0);
  }
}
console.log('TIMEOUT / no end event');
process.exit(1);
