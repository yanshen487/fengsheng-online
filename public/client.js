/* ================================================================
   风声 · 联机客户端
   服务器权威：本文件只做「渲染 + 询问交互 + 动画演出」，不含任何规则判定
   ================================================================ */
const $ = id => document.getElementById(id);

let META = null;   // CHARS / FACTION / COLOR / CARD_DESC ...（服务器下发）
let V = null;      // 服务器视图（含可见性过滤）
let JOIN = null;   // { code, pid, token, host }
let inGame = false;
let curAsk = null; // { qid, payload }
let pendingWin = null;
let actionOpen = false;
let playableIds = [];
let autoCode = null;

const LS_NAME = 'fs_name';
const LS_ROOM = 'fs_room';
const LS_TOKEN = c => 'fs_token_' + c;

/* ================================================================
   WebSocket 连接与重连
   ================================================================ */
let ws = null;
function wsURL() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host; }
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function setState(t) { const e = $('hdr-state'); if (e) e.textContent = t; }

function connect(afterOpen) {
  ws = new WebSocket(wsURL());
  ws.onopen = () => { setState('已连接'); if (afterOpen) afterOpen(); };
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMsg(m); };
  ws.onclose = () => {
    setState('连接断开');
    if (inGame && JOIN) toast('⚠ 与服务器断开，正在重连…', 4000);
    setTimeout(() => connect(autoRejoin), 1500);
  };
  ws.onerror = () => { };
}

// 断线后的自动恢复：能找回房间就重连入座，否则仅重连
function autoRejoin() {
  if (JOIN) return send({ t: 'rejoin', token: JOIN.token });
  let code = autoCode;
  if (!code) { try { code = localStorage.getItem(LS_ROOM); } catch { } }
  if (!code) return;
  try {
    const token = localStorage.getItem(LS_TOKEN(code));
    if (token) send({ t: 'rejoin', token });
  } catch { }
}

/* ================================================================
   消息分发
   ================================================================ */
function onMsg(m) {
  switch (m.t) {
    case 'joined': {
      JOIN = { code: m.code, pid: m.pid, token: m.token, host: m.host };
      try { localStorage.setItem(LS_TOKEN(m.code), m.token); localStorage.setItem(LS_ROOM, m.code); } catch { }
      $('hdr-code').textContent = m.code;
      $('hdr-seat').textContent = (m.pid + 1) + ' 号位';
      if (!inGame) enterLobbyRoom(m);
      break;
    }
    case 'lobby': if (!inGame) refreshLobby(m); break;
    case 'meta': META = m.meta; break;
    case 'gameStart': startLocalGame(); break;
    case 'view':
      if (!inGame) startLocalGame();
      V = m.view;
      if (m.full && V && V.log) rebuildLog();
      renderAll();
      break;
    case 'log': appendLog(m.msg, m.cls); break;
    case 'toast': toast(m.html, m.ms || 2600); break;
    case 'anim': playAnim(m.cue); break;
    case 'ask': handleAsk(m); break;
    case 'askClose': if (curAsk && curAsk.qid === m.qid) { closeAskUI(); toast('⌛ 该操作已超时，自动继续。', 2600); } break;
    case 'declare': setDeclare(m.win); break;
    case 'over': showResult(m.result); break;
    case 'rematchWait': {
      const s = $('rematch-status');
      if (s) s.textContent = `已准备 ${m.ready.length} 人，等待其他玩家…`;
      break;
    }
    case 'err':
      if (inGame) toast('⚠ ' + m.msg, 4200);
      else {
        const e = $('lobby-err'); if (e) e.textContent = m.msg;
        if (m.code === 'REJOIN_FAIL') {
          // 重连失败：清掉自动重连记录，回到输入代号的本机状态
          try {
            const old = localStorage.getItem(LS_ROOM);
            if (old) localStorage.removeItem(LS_TOKEN(old));
            localStorage.removeItem(LS_ROOM);
          } catch { }
          autoCode = null;
          $('lobby-code').value = '';
          JOIN = null;
          $('lobby-name').focus();
        }
      }
      break;
  }
}

/* ================================================================
   大厅
   ================================================================ */
function enterLobbyRoom(m) {
  $('lobby').style.display = 'flex';
  $('lobby-home').style.display = 'none';
  $('lobby-room').style.display = 'block';
  $('lobby-err').textContent = '';
  $('room-code').textContent = m.code;
  refreshLobby({ seats: m.seats, host: m.host, code: m.code });
}

function refreshLobby(m) {
  const seats = m.seats || [];
  $('seat-list').innerHTML = seats.map(s => {
    const me = JOIN && JOIN.pid === s.idx;
    let tag = '';
    if (s.kind === 'ai') tag = '<span class="tag ai">电脑</span>';
    else if (!s.connected) tag = '<span class="tag off">断线</span>';
    const crown = s.host ? '<span class="tag">房主</span>' : '';
    return `<div class="seat-row ${me ? 'me' : ''}">
      <span class="who">${s.idx + 1} 号位 · <b>${s.name}</b>${me ? '（你）' : ''}</span>
      <span class="who">${crown}${tag}</span>
    </div>`;
  }).join('');
  const isHost = JOIN && JOIN.pid === m.host;
  $('btn-start').style.display = isHost ? 'inline-block' : 'none';
  $('lobby-status').textContent = isHost
    ? '空位将由电脑补足，可直接开始；把房间号发给朋友可一起加入。'
    : '等待房主开始游戏…';
}

function leaveRoom() {
  send({ t: 'leave' });
  try {
    if (JOIN) localStorage.removeItem(LS_TOKEN(JOIN.code));
    localStorage.removeItem(LS_ROOM);
  } catch { }
  JOIN = null;
  autoCode = null;
  if ($('lobby-code')) $('lobby-code').value = '';
  $('lobby-home').style.display = 'block';
  $('lobby-room').style.display = 'none';
  $('lobby-err').textContent = '';
  $('hdr-code').textContent = '—';
  $('hdr-seat').textContent = '—';
}

/* ================================================================
   开局 / 结束
   ================================================================ */
function startLocalGame() {
  inGame = true;
  V = null;
  curAsk = null;
  pendingWin = null;
  actionOpen = false;
  playableIds = [];
  $('lobby').style.display = 'none';
  $('overlay').classList.remove('show');
  $('overlay2').style.display = 'none';
  $('declare-btn').style.display = 'none';
  $('ansha-btn').style.display = 'none';
  $('ansha-pass-btn').style.display = 'none';
  $('action-bar').style.display = 'none';
  $('chengren-btn').style.display = 'none';
  $('ask-timer').style.display = 'none';
  dropFloatCard();
  $('log').innerHTML = '';
  $('hand').innerHTML = '';
  $('skillbar').innerHTML = '';
  ['seat-0', 'seat-1', 'seat-2', 'seat-3'].forEach(s => $(s).innerHTML = '');
  $('transit').innerHTML = '';
  setState('对局中');
}

function showResult(r) {
  const myFaction = V && V.players ? V.players[V.me].faction : null;
  const win = myFaction === r.win.faction;
  const F = META.FACTION;
  $('result-dialog').innerHTML = `
    <div class="big ${win ? 'win' : 'lose'}">${win ? '胜 利' : '败 北'}</div>
    <div class="reason">胜者阵营：${F[r.win.faction].name} —— ${r.win.reason}</div>
    <div class="id-summary">${r.players.map(p =>
      `#${p.id + 1} <b>${p.name}</b> · ${p.charName} · ${F[p.faction].name}${p.dead ? ' · 出局（' + p.deathCause + '）' : ''}`
    ).join('<br>')}</div>
    <div class="close">
      <button id="btn-rematch" class="btn primary">再来一局</button>
      <button class="btn" onclick="location.reload()">返回大厅</button>
    </div>
    <div class="lobby-status" id="rematch-status"></div>`;
  $('overlay2').style.display = 'flex';
  $('btn-rematch').onclick = () => {
    send({ t: 'rematch' });
    $('rematch-status').textContent = '已准备，等待其他玩家…';
  };
  setState('对局结束');
  renderAll();
}

function setDeclare(win) {
  pendingWin = win;
  const btn = $('declare-btn');
  if (win) {
    btn.style.display = 'inline-block';
    toast(`★ 你的阵营「${META.FACTION[win.faction].name}」已达成宣胜条件：${win.reason}<br>可点右上角「宣 胜」结束对局，或继续游戏。`, 5200);
  } else {
    btn.style.display = 'none';
  }
}

/* ================================================================
   渲染（座位 → 视图序号：底=自己，右=下家，上=对家，左=上家）
   ================================================================ */
const relOf = pid => (pid - V.me + 4) % 4;
const seatEl = pid => $('seat-' + relOf(pid));
const pname = i => (V.players[i] ? V.players[i].name : '?');

function cardHTML(card, opts = {}) {
  if (!card) return '';
  const cls = card.color === 'redblue' ? 'redblue' : card.color;
  const methodTxt = card.method === 'text' ? '文本' : card.method === 'cipher' ? '密电' : card.method === 'direct' ? '直达' : '任选';
  let marks = '';
  if (card.rotate) marks += '<span class="mk rot">旋</span>';
  if (card.lock) marks += '<span class="mk lock">锁</span>';
  const faceDown = opts.faceDown ? 'face-down' : '';
  if (faceDown) {
    return `<div class="card face-down ${opts.selectable ? 'selectable' : ''}" data-id="${card.id}">
      <span class="cname">密</span><span class="csub">反面朝上</span></div>`;
  }
  return `<div class="card ${cls} ${opts.selectable ? 'selectable' : ''} ${opts.dim ? 'dim' : ''}" data-id="${card.id}">
    <span class="method-badge">${methodTxt}</span>
    <span class="marks">${marks}</span>
    <span class="cname">${card.name}</span>
    <span class="csub">${card.kind === 'gongkai' ? '按阵营摸牌' : card.kind === 'weixian' ? '检视弃置' : card.kind === 'jimi' ? '视真情报数' : ''}</span>
  </div>`;
}

function renderAll() {
  if (!V) return;
  $('deck-cnt').textContent = '牌堆 ' + V.deckCount;
  $('discard-cnt').textContent = '弃牌 ' + V.discardCount;
  V.players.forEach(p => { seatEl(p.id).innerHTML = renderPlayer(p); });
  renderTransit();
  renderHand();
  renderSkillbar();
}

function renderPlayer(p) {
  const cur = p.id === V.current && !V.gameOver;
  const seal = p.known
    ? `<div class="seal ${p.faction}">${META.FACTION[p.faction].name}</div>`
    : `<div class="seal hidden">？</div>`;
  let intels = '';
  p.intel.forEach(c => {
    const cls = c.color === 'redblue' ? 'redblue' : c.color;
    const mk = c.lock ? '<span class="m">锁</span>' : '';
    const label = c.color === 'redblue' ? '红蓝' : META.COLOR[c.color].name;
    intels += `<div class="intel-slot ${cls}" title="${c.name}">${label}${mk}</div>`;
  });
  const skills = META.CHARS[p.char].skills.map(s => s.name).join('·');
  let employer = '';
  if (p.employer !== null && p.employer !== undefined) employer = ` 雇主：${pname(p.employer)}`;
  const charName = META.CHARS[p.char].name;
  const revealNote = p.known ? '' : '（未暴露）';
  const handTxt = p.id === V.me ? p.hand.length : p.handCount;
  return `<div class="player ${cur ? 'cur' : ''} ${p.dead ? 'dead' : ''}">
    ${seal}
    <div class="pname">${p.name} ${cur ? '<span class="turnmark">● 行动中</span>' : ''}</div>
    <div class="pinfo">
      角色：<b>${charName}</b>${employer}<br>
      阵营：${p.known ? `<b>${META.FACTION[p.faction].name}</b>` : '<b style="color:#a99a76">隐藏</b>'}${revealNote}<br>
      技能：${skills}<br>
      手牌：<b>${handTxt}</b> 张
    </div>
    <div class="intel-area"><div class="lbl">情报区</div>${intels || '<span style="font-size:11px;color:#5a4f3a">（空）</span>'}</div>
  </div>`;
}

function methodName(m) { return m === 'text' ? '文本' : m === 'cipher' ? '密电' : m === 'direct' ? '直达' : '任选'; }
function directionName(d) { return d === 'cw' ? '顺时针' : '逆时针'; }

function renderTransit() {
  const el = $('transit');
  const t = V.transit;
  if (!t) { el.innerHTML = `<div class="info">等待情报传递…</div>`; return; }
  const faceDown = !t.faceUp;
  const c = t.card;
  const cardStr = faceDown
    ? `<div class="transit-card face-down">反<br>面<br>朝<br>上</div>`
    : `<div class="transit-card ${c.color === 'redblue' ? 'redblue' : c.color}">${c.name}<br><small>${c.color === 'redblue' ? '红蓝' : META.COLOR[c.color].name}</small></div>`;
  el.innerHTML = `${cardStr}<div class="info">传出者 <b>${pname(t.sender)}</b><br>方式 <b>${methodName(t.method)}</b>${t.method !== 'direct' ? ' · ' + directionName(t.direction) : ''}<br>${faceDown ? '<b>反面朝上</b>' : '<b>正面朝上</b>'}</div>`;
}

/* ---------------- 手牌 ---------------- */
function renderHand() {
  if (!V) return;
  const p = V.players[V.me];
  const box = $('hand');
  const hint = $('hand-hint');
  box.innerHTML = '';
  if (p.dead) { hint.textContent = '你已出局，观战中…'; return; }
  hint.textContent = `${p.hand.length} 张 · 情报区 ${p.intel.length} 张` + (actionOpen ? ' · 点击高亮牌传出情报' : '');
  p.hand.forEach(c => {
    const div = document.createElement('div');
    const sel = actionOpen && playableIds.includes(c.id);
    div.innerHTML = cardHTML(c, { selectable: sel, dim: actionOpen && !sel });
    box.appendChild(div.firstChild);
  });
}

$('hand').addEventListener('click', e => {
  const el = e.target.closest('.card');
  if (!el || !actionOpen || !curAsk || curAsk.payload.kind !== 'action') return;
  const id = Number(el.dataset.id);
  if (playableIds.includes(id)) answer({ a: 'play', cardId: id });
});

function renderSkillbar() {
  if (!V) return;
  const p = V.players[V.me];
  const box = $('skillbar');
  if (p.dead) { box.innerHTML = ''; return; }
  let html = '';
  META.CHARS[p.char].skills.forEach(s => {
    html += `<span class="skill-chip"><b>${s.name}</b>：${s.desc}</span>`;
  });
  html += `<span class="skill-chip">秘密任务：<b>${META.CHARS[p.char].secret}</b></span>`;
  box.innerHTML = html;
}

/* ================================================================
   桌面情报动画
   ================================================================ */
let _floatEl = null;
function floatCardEl() {
  if (!_floatEl) {
    _floatEl = document.createElement('div');
    _floatEl.className = 'float-wrap';
    document.body.appendChild(_floatEl);
  }
  return _floatEl;
}
function paintFloatCard(cue) {
  const el = floatCardEl();
  const faceDown = !!cue.faceDown;
  const card = cue.card;
  const cls = faceDown ? 'face-down' : (card ? (card.color === 'redblue' ? 'redblue' : card.color) : '');
  el.innerHTML = `<div class="float-card ${cls}">${faceDown ? '密' : (card ? card.name : '')}</div>`;
}
function seatCenterXY(pid) {
  const el = seatEl(pid);
  const r = el ? el.getBoundingClientRect() : null;
  return { x: r ? r.left + r.width / 2 : innerWidth / 2, y: r ? r.top + r.height / 2 : innerHeight / 2 };
}
function teleportFloatToSeat(pid) {
  const el = floatCardEl();
  const xy = seatCenterXY(pid);
  el.style.transition = 'none';
  el.style.left = xy.x + 'px'; el.style.top = xy.y + 'px';
  void el.offsetWidth;
}
function animateFloatToSeat(pid, ms) {
  const el = floatCardEl();
  const xy = seatCenterXY(pid);
  el.style.transition = `left ${ms}ms ease-in-out, top ${ms}ms ease-in-out`;
  el.style.left = xy.x + 'px'; el.style.top = xy.y + 'px';
}
function dropFloatCard() { if (_floatEl) { _floatEl.remove(); _floatEl = null; } }

function playAnim(cue) {
  if (!cue) return;
  switch (cue.a) {
    case 'floatNew': paintFloatCard(cue); break;
    case 'floatTeleport': teleportFloatToSeat(cue.seat); break;
    case 'floatMove': animateFloatToSeat(cue.seat, cue.ms || 460); break;
    case 'floatDrop': dropFloatCard(); break;
  }
}

/* ================================================================
   询问交互（服务器 ask → 本机作答）
   ================================================================ */
let _askTimerHandle = null;
function startAskTimer(timeoutMs, qid) {
  stopAskTimer();
  let left = Math.ceil((timeoutMs || 60000) / 1000);
  const el = $('ask-timer');
  const tick = () => {
    el.innerHTML = `⏳ 剩 ${left}s`;
    el.style.display = 'inline-block';
    if (left <= 0) { stopAskTimer(); return; }
    left--;
  };
  tick();
  _askTimerHandle = setInterval(tick, 1000);
}
function stopAskTimer() {
  if (_askTimerHandle) clearInterval(_askTimerHandle);
  _askTimerHandle = null;
  $('ask-timer').style.display = 'none';
}

function handleAsk(m) {
  curAsk = { qid: m.qid, payload: m.payload };
  startAskTimer(m.timeout, m.qid);
  const p = m.payload;
  switch (p.kind) {
    case 'dialog': openDialog(p.title, `<div class="body">${p.html}</div>`, p.options || []); break;
    case 'pickHand': {
      const me = V.players[V.me];
      const cards = me.hand.filter(c => p.cardIds.includes(c.id));
      openCardPick(p.title || '选择手牌', cards, p.allowCancel);
      break;
    }
    case 'cardList': openCardPick(p.title || '选择卡牌', p.cards || [], p.allowCancel); break;
    case 'pickPlayer': openPlayerPick(p); break;
    case 'action': openAction(p); break;
    case 'assassin': openAssassin(); break;
  }
}

function openDialog(title, bodyHtml, options) {
  const ov = $('overlay');
  $('dialog').innerHTML = `<h2>${title}</h2>${bodyHtml}
    <div class="opts">${options.map((o, i) =>
    `<button class="btn ${o.cls || 'opt-btn'}" data-i="${i}">${o.label}</button>`).join('')}</div>`;
  $('dialog').querySelectorAll('.opts .btn').forEach(btn => {
    btn.onclick = () => answer(options[Number(btn.dataset.i)].value);
  });
  ov.classList.add('show');
}

function openCardPick(title, cards, allowCancel) {
  const ov = $('overlay');
  $('dialog').innerHTML = `<h2>${title}</h2>
    <div class="card-grid">${cards.map(c => cardHTML(c)).join('')}</div>
    ${allowCancel ? '<div class="opts"><button class="btn opt-btn" id="pk-cancel">取消</button></div>' : ''}`;
  $('dialog').querySelectorAll('.card').forEach(el => {
    el.onclick = () => answer(Number(el.dataset.id));
  });
  const cancel = $('pk-cancel');
  if (cancel) cancel.onclick = () => answer(null);
  ov.classList.add('show');
}

function openPlayerPick(p) {
  const ov = $('overlay');
  $('dialog').innerHTML = `<h2>${p.title || '选择目标'}</h2>
    <div class="ply-grid">${p.playerIds.map(id => {
    const q = V.players[id];
    return `<button class="btn opt-btn ply-btn" data-pid="${id}">${q.name}<br><span style="font-size:11px;opacity:.85">${META.CHARS[q.char].name}</span></button>`;
  }).join('')}</div>
    ${p.allowCancel ? '<div class="opts"><button class="btn opt-btn" id="pk-cancel">取消</button></div>' : ''}`;
  $('dialog').querySelectorAll('.ply-btn').forEach(el => {
    el.onclick = () => answer(Number(el.dataset.pid));
  });
  const cancel = $('pk-cancel');
  if (cancel) cancel.onclick = () => answer(null);
  ov.classList.add('show');
}

function openAction(p) {
  actionOpen = true;
  playableIds = p.playableIds || [];
  $('action-bar').style.display = 'flex';
  $('chengren-btn').style.display = p.canChengren ? 'inline-block' : 'none';
  renderHand();
  if (playableIds.length === 0) toast('本回合无可打出的功能牌，请点「结束出牌」。', 2600);
}

function openAssassin() {
  $('ansha-btn').style.display = 'inline-block';
  $('ansha-pass-btn').style.display = 'inline-block';
  toast('职业杀手机会：可点右上角「暗 杀」发动，或「跳 过」。', 3600);
}

function answer(ans) {
  if (!curAsk) return;
  const qid = curAsk.qid;
  curAsk = null;
  closeAskUI();
  send({ t: 'answer', qid, ans });
}

function closeAskUI() {
  stopAskTimer();
  $('overlay').classList.remove('show');
  $('action-bar').style.display = 'none';
  $('ansha-btn').style.display = 'none';
  $('ansha-pass-btn').style.display = 'none';
  $('chengren-btn').style.display = 'none';
  actionOpen = false;
  playableIds = [];
  renderHand();
}

/* ================================================================
   日志 / 提示
   ================================================================ */
function appendLog(msg, cls) {
  const box = $('log');
  const d = document.createElement('div');
  d.className = 'entry' + (cls ? ' ' + cls : '');
  d.innerHTML = msg;
  box.appendChild(d);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function rebuildLog() {
  const box = $('log');
  box.innerHTML = '';
  (V.log || []).forEach(e => appendLog(e.msg, e.cls));
}

let _toastTimer = null;
function toast(html, ms = 2600) {
  const t = $('toast');
  t.innerHTML = html;
  t.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
}

/* ================================================================
   静态按钮
   ================================================================ */
$('declare-btn').addEventListener('click', () => {
  if (!pendingWin) return;
  $('declare-btn').style.display = 'none';
  send({ t: 'declare' });
});
$('ansha-btn').addEventListener('click', () => { if (curAsk && curAsk.payload.kind === 'assassin') answer(true); });
$('ansha-pass-btn').addEventListener('click', () => { if (curAsk && curAsk.payload.kind === 'assassin') answer(false); });
$('act-pass').addEventListener('click', () => { if (curAsk && curAsk.payload.kind === 'action') answer('pass'); });
$('chengren-btn').addEventListener('click', () => { if (curAsk && curAsk.payload.kind === 'action') answer({ a: 'chengren' }); });

$('btn-create').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  try { localStorage.setItem(LS_NAME, name); } catch { }
  $('lobby-err').textContent = '';
  send({ t: 'create', name });
});
$('btn-join').addEventListener('click', () => {
  const name = $('lobby-name').value.trim();
  const code = $('lobby-code').value.trim();
  try { localStorage.setItem(LS_NAME, name); } catch { }
  $('lobby-err').textContent = '';
  if (!/^\d{4}$/.test(code)) { $('lobby-err').textContent = '请输入 4 位数字房间号。'; return; }
  send({ t: 'join', code, name });
});
$('btn-start').addEventListener('click', () => send({ t: 'start' }));
$('btn-leave').addEventListener('click', leaveRoom);
$('btn-copy').addEventListener('click', () => {
  const text = JOIN ? location.origin + '/?room=' + JOIN.code : '';
  const done = () => toast(`已复制邀请链接：<br>${text}`, 3600);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => toast('复制失败，请手动分享房间号 ' + (JOIN ? JOIN.code : ''), 3600));
  } else toast('你的浏览器不支持自动复制，请手动分享房间号 ' + (JOIN ? JOIN.code : ''), 3600);
});
$('lobby-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
$('lobby-name').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (autoCode && $('lobby-code').value) $('btn-join').click();
  else $('btn-create').click();
});

/* ================================================================
   启动
   ================================================================ */
(function boot() {
  try { $('lobby-name').value = localStorage.getItem(LS_NAME) || ''; } catch { }
  const q = new URLSearchParams(location.search);
  const h = (location.hash.match(/room=(\d{4})/) || [])[1];
  let lastRoom = null;
  try { lastRoom = localStorage.getItem(LS_ROOM); } catch { }
  autoCode = q.get('room') || h || lastRoom || null;
  if (autoCode) $('lobby-code').value = autoCode;
  connect(() => {
    if (autoCode) {
      let token = null;
      try { token = localStorage.getItem(LS_TOKEN(autoCode)); } catch { }
      if (token) {
        $('lobby-err').textContent = '正在尝试重连到房间 ' + autoCode + ' …';
        send({ t: 'rejoin', token });
      } else {
        $('lobby-err').textContent = '输入代号后回车，即可加入房间 ' + autoCode;
        $('lobby-name').focus();
      }
    }
  });
})();
