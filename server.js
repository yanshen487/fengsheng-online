/* 风声 · 联机服务器
 * HTTP 静态服务（public/）+ WebSocket 房间大厅 + 服务器权威引擎调度
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createEngine, CHARS, FACTION, FACTION_CSS, COLOR, CODEWORDS, CARD_DESC, FUNC_KINDS } from './engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const MAX_ROOMS = 300;
const AI_NAME_POOL = ['老鬼', '白小年', '阿六', '老枪', '夜莺', '黄雀', '刀疤', '铁柱', '海棠', '青鸾'];

/* ================================================================
   HTTP 静态服务
   ================================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('pong'); }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ================================================================
   房间
   ================================================================ */
const rooms = new Map();   // code -> Room
const tokens = new Map();  // token -> {code, pid}

const META = { FACTION, FACTION_CSS, COLOR, CODEWORDS, CHARS, CARD_DESC, FUNC_KINDS };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function newCode() {
  for (let i = 0; i < 500; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

class Room {
  constructor(code) {
    this.code = code;
    this.seats = [null, null, null, null]; // seat: {name, isHuman, ws, token, connected, aiName}
    this.host = null;
    this.started = false;
    this.over = false;
    this.lastResult = null;
    this.engine = null;
    this.pending = new Map();  // qid -> {pid, resolve, timer, kind}
    this.qidSeq = 0;
    this.rematch = new Set();
    this.lastActive = Date.now();
    this.aiNames = null;
  }
  touch() { this.lastActive = Date.now(); }
  humans() { return this.seats.map((s, i) => s && { ...s, pid: i }).filter(Boolean); }
  connectedHumans() { return this.seats.filter(s => s && s.connected); }
  lobbyView() {
    const names = this.ensureAiNames();
    let aiN = 0;
    return this.seats.map((s, i) => {
      if (s) return { idx: i, kind: 'human', name: s.name, connected: s.connected, host: this.host === i };
      return { idx: i, kind: 'ai', name: `电脑·${names[aiN++ % names.length]}` };
    });
  }
  // 大厅预览与开局使用同一份电脑名，避免预览与实际不符
  ensureAiNames() {
    if (!this.aiNames) this.aiNames = [...AI_NAME_POOL].sort(() => Math.random() - 0.5);
    return this.aiNames;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ } }
}
function sendTo(room, pid, obj) {
  const s = room.seats[pid];
  if (s) send(s.ws, obj);
}
function broadcast(room, obj) {
  room.seats.forEach(s => { if (s) send(s.ws, obj); });
}

/* ================================================================
   引擎 io 适配层
   ================================================================ */
const KIND_TIMEOUT = { assassin: 30000 };
function askTimeoutFor(payload) {
  if (!payload) return 60000;
  if (KIND_TIMEOUT[payload.kind]) return KIND_TIMEOUT[payload.kind];
  if (payload.kind === 'dialog' && payload.options && payload.options[0] && payload.options[0].cls === 'primary') return 120000;
  if (payload.kind === 'cardList') return 45000;
  return 60000;
}

function askPlayer(room, pid, payload, def) {
  const seat = room.seats[pid];
  if (!seat || !seat.isHuman) return Promise.resolve(def);
  const qid = ++room.qidSeq;
  const timeout = askTimeoutFor(payload);
  return new Promise(resolve => {
    const finish = (val, timedOut) => {
      const e = room.pending.get(qid);
      if (!e) return;
      clearTimeout(e.timer);
      room.pending.delete(qid);
      if (timedOut) {
        send(seat.ws, { t: 'askClose', qid, timeout: true });
        if (payload.kind !== 'assassin') {
          broadcast(room, { t: 'toast', html: `⌛ <b>${seat.name}</b> 操作超时，已自动继续。`, ms: 2600 });
        }
      }
      resolve(val);
    };
    const effTimeout = seat.connected ? timeout : Math.min(timeout, 8000);
    const timer = setTimeout(() => finish(def, true), effTimeout);
    room.pending.set(qid, { pid, resolve: finish, timer, kind: payload.kind, payload });
    send(seat.ws, { t: 'ask', qid, payload, timeout: effTimeout });
  });
}

function makeIO(room) {
  return {
    ask(pid, payload, def) { return askPlayer(room, pid, payload, def); },
    pushView(pid, view) { sendTo(room, pid, { t: 'view', view }); },
    log(msg, cls, to) {
      if (!to) broadcast(room, { t: 'log', msg, cls });
      else to.forEach(pid => sendTo(room, pid, { t: 'log', msg, cls }));
    },
    toast(html, ms) { broadcast(room, { t: 'toast', html, ms: ms || 2600 }); },
    anim(cue) { broadcast(room, { t: 'anim', cue }); },
    declareOffer(pid, win) { sendTo(room, pid, { t: 'declare', win }); },
    ended(result) {
      room.over = true;
      room.lastResult = result;
      room.rematch = new Set();
      room.pending.forEach(e => { clearTimeout(e.timer); e.resolve(null); });
      room.pending.clear();
      broadcast(room, { t: 'over', result });
    },
  };
}

/* ================================================================
   游戏生命周期
   ================================================================ */
async function startGame(room) {
  room.started = true;
  room.over = false;
  room.rematch = new Set();
  room.engine = null;
  const aiNames = room.ensureAiNames();
  let aiN = 0;
  const seatsArg = room.seats.map(s => s
    ? { name: s.name, isHuman: true }
    : { name: `电脑·${aiNames[aiN++ % aiNames.length]}`, isHuman: false });
  const engine = createEngine(makeIO(room));
  room.engine = engine;
  broadcast(room, { t: 'gameStart' });
  try {
    await engine.start(seatsArg);
    room.started = false;
  } catch (err) {
    console.error('[room ' + room.code + '] engine error:', err);
    broadcast(room, { t: 'err', msg: '服务器内部错误，本局已终止。' });
    room.started = false;
  }
}

function leaveSeat(room, pid) {
  const s = room.seats[pid];
  if (!s) return;
  if (s.token) tokens.delete(s.token);
  room.seats[pid] = null;
  if (room.host === pid) {
    const nh = room.seats.findIndex(x => x && x.connected);
    room.host = nh >= 0 ? nh : null;
  }
}
function dropRoom(room) {
  room.pending.forEach(e => { clearTimeout(e.timer); e.resolve(null); });
  room.pending.clear();
  rooms.delete(room.code);
}

/* ================================================================
   WebSocket
   ================================================================ */
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null;
  ws.pid = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (err) { console.error('handle error', m.t, err); send(ws, { t: 'err', msg: '操作失败：' + err.message }); }
  });

  ws.on('close', () => {
    const room = ws.room, pid = ws.pid;
    if (!room || pid === null) return;
    const seat = room.seats[pid];
    if (!seat || seat.ws !== ws) return;
    seat.connected = false;
    seat.ws = null;
    room.touch();
    if (!room.started) {
      const name = seat.name;
      leaveSeat(room, pid);
      if (room.seats.every(s => !s)) return dropRoom(room);
      broadcast(room, { t: 'lobby', seats: room.lobbyView(), host: room.host, code: room.code });
      broadcast(room, { t: 'toast', html: `<b>${name}</b> 离开了房间。`, ms: 2200 });
    } else if (!room.over) {
      broadcast(room, { t: 'toast', html: `⌛ <b>${seat.name}</b> 已断线，等待重连（其操作将自动超时）。`, ms: 3200 });
    }
  });
});

function handle(ws, m) {
  switch (m.t) {
    case 'create': return doCreate(ws, m);
    case 'join': return doJoin(ws, m);
    case 'rejoin': return doRejoin(ws, m);
    case 'start': return doStart(ws);
    case 'answer': return doAnswer(ws, m);
    case 'declare': return doDeclare(ws);
    case 'rematch': return doRematch(ws);
    case 'leave': return doLeave(ws);
    default: send(ws, { t: 'err', msg: '未知指令：' + m.t });
  }
}

function cleanName(s, fallback) {
  const n = String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 12);
  return n || fallback;
}

function doCreate(ws, m) {
  if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: '服务器房间数已满，请稍后再试。' });
  const code = newCode();
  if (!code) return send(ws, { t: 'err', msg: '房间号分配失败，请重试。' });
  const room = new Room(code);
  rooms.set(code, room);
  const name = cleanName(m.name, '房主');
  const token = randomUUID();
  room.seats[0] = { name, isHuman: true, ws, token, connected: true };
  room.host = 0;
  tokens.set(token, { code, pid: 0 });
  ws.room = room; ws.pid = 0;
  send(ws, { t: 'joined', code, pid: 0, token, host: 0, seats: room.lobbyView() });
  send(ws, { t: 'meta', meta: META });
}

function doJoin(ws, m) {
  const code = String(m.code || '').trim();
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', msg: '房间不存在，请核对房间号。' });
  if (room.started || room.over) return send(ws, { t: 'err', msg: '该房间已开局，无法加入新玩家。' });
  const free = room.seats.findIndex(s => !s);
  if (free < 0) return send(ws, { t: 'err', msg: '该房间已满员（4/4）。' });
  const name = cleanName(m.name, '玩家' + (free + 1));
  if (room.seats.some(s => s && s.name === name)) return send(ws, { t: 'err', msg: '该昵称已被占用，请换一个。' });
  const token = randomUUID();
  room.seats[free] = { name, isHuman: true, ws, token, connected: true };
  tokens.set(token, { code, pid: free });
  ws.room = room; ws.pid = free;
  room.touch();
  send(ws, { t: 'joined', code, pid: free, token, host: room.host, seats: room.lobbyView() });
  send(ws, { t: 'meta', meta: META });
  broadcast(room, { t: 'lobby', seats: room.lobbyView(), host: room.host, code: room.code });
  broadcast(room, { t: 'toast', html: `<b>${name}</b> 加入了房间。`, ms: 2200 });
}

function doRejoin(ws, m) {
  const info = tokens.get(String(m.token || ''));
  if (!info) return send(ws, { t: 'err', msg: '重连凭证无效或已过期。', code: 'REJOIN_FAIL' });
  const room = rooms.get(info.code);
  if (!room) return send(ws, { t: 'err', msg: '房间已解散。', code: 'REJOIN_FAIL' });
  const seat = room.seats[info.pid];
  if (!seat) return send(ws, { t: 'err', msg: '座位已释放，无法重连。', code: 'REJOIN_FAIL' });
  seat.ws = ws; seat.connected = true;
  ws.room = room; ws.pid = info.pid;
  room.touch();
  const token = seat.token;
  send(ws, { t: 'joined', code: room.code, pid: info.pid, token, host: room.host, seats: room.lobbyView() });
  send(ws, { t: 'meta', meta: META });
  if (room.started && room.engine) {
    send(ws, { t: 'gameStart' });
    const v = room.engine.viewFor(info.pid, true);
    send(ws, { t: 'view', view: v, full: true });
    for (const [qid, e] of room.pending) {
      if (e.pid === info.pid) {
        send(ws, { t: 'ask', qid, payload: e.payload, timeout: 60000, resent: true });
      }
    }
    broadcast(room, { t: 'toast', html: `<b>${seat.name}</b> 已重连。`, ms: 2200 });
  } else if (room.over) {
    if (room.engine) {
      send(ws, { t: 'gameStart' });
      send(ws, { t: 'view', view: room.engine.viewFor(info.pid, true), full: true });
    }
    if (room.lastResult) send(ws, { t: 'over', result: room.lastResult });
    send(ws, { t: 'rematchWait', ready: [...room.rematch] });
  } else {
    broadcast(room, { t: 'lobby', seats: room.lobbyView(), host: room.host, code: room.code });
    broadcast(room, { t: 'toast', html: `<b>${seat.name}</b> 已加入。`, ms: 2200 });
  }
}

function doStart(ws) {
  const room = ws.room;
  if (!room || ws.pid === null) return;
  if (ws.pid !== room.host) return send(ws, { t: 'err', msg: '只有房主可以开始游戏。' });
  if (room.started) return;
  const n = room.connectedHumans().length;
  if (n < 1) return send(ws, { t: 'err', msg: '至少需要一名玩家。' });
  startGame(room);
}

function doAnswer(ws, m) {
  const room = ws.room;
  if (!room || ws.pid === null) return;
  const e = room.pending.get(m.qid);
  if (!e || e.pid !== ws.pid) return;
  room.touch();
  e.resolve(m.ans);
}

function doDeclare(ws) {
  const room = ws.room;
  if (!room || !room.engine || ws.pid === null) return;
  room.engine.declare(ws.pid);
}

function doRematch(ws) {
  const room = ws.room;
  if (!room || ws.pid === null) return;
  if (!room.over) return;
  room.rematch.add(ws.pid);
  broadcast(room, { t: 'rematchWait', ready: [...room.rematch] });
  const allReady = room.connectedHumans().length > 0
    && room.connectedHumans().every(s => room.rematch.has(room.seats.indexOf(s)));
  if (allReady) startGame(room);
}

function doLeave(ws) {
  const room = ws.room;
  if (!room || ws.pid === null) return;
  const seat = room.seats[ws.pid];
  const name = seat ? seat.name : '玩家';
  if (!room.started) {
    leaveSeat(room, ws.pid);
    ws.room = null; ws.pid = null;
    if (room.seats.every(s => !s)) return dropRoom(room);
    broadcast(room, { t: 'lobby', seats: room.lobbyView(), host: room.host, code: room.code });
    broadcast(room, { t: 'toast', html: `<b>${name}</b> 离开了房间。`, ms: 2200 });
  } else if (seat) {
    seat.connected = false; seat.ws = null;
    ws.room = null; ws.pid = null;
    if (!room.over) broadcast(room, { t: 'toast', html: `⌛ <b>${name}</b> 已离开，等待重连。`, ms: 3200 });
  }
}

/* ================================================================
   心跳 & 清理
   ================================================================ */
const hb = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30000);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const idle = now - room.lastActive;
    const conn = room.connectedHumans().length;
    if (conn === 0 && idle > 30 * 60 * 1000) { dropRoom(room); continue; }
    if (!room.started && !room.over && conn === 0 && idle > 15 * 60 * 1000) dropRoom(room);
  }
}, 60000);

/* ================================================================
   启动
   ================================================================ */
httpServer.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  风声 · 联机服务器已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  lan.forEach(ip => console.log(`  局域网访问: http://${ip}:${PORT}`));
  console.log('  （Ctrl+C 停止服务）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

process.on('SIGINT', () => { clearInterval(hb); clearInterval(sweeper); process.exit(0); });
