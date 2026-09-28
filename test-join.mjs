/* 双人对局测试用「虚拟玩家」：加入指定房间，自动应答，并校验视图无隐藏信息泄露
   用法: node test-join.mjs <房间号> [代号] [--accept] */
const URL = process.env.URL || 'ws://localhost:8787';
const code = process.argv[2];
const myName = process.argv[3] || '好友A';
if (!/^\d{4}$/.test(code || '')) { console.error('用法: node test-join.mjs <4位房间号> [代号]'); process.exit(1); }

const strip = s => String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
const ws = new WebSocket(URL);
let me = null, logCount = 0, askCount = 0, viewCount = 0;
let leaks = [];

function leakCheck(v) {
  if (!v) return;
  v.players.forEach(p => {
    if (p.id !== v.me) {
      if (p.hand !== null) leaks.push(`座位${p.id} 的手牌被下发给了座位${v.me}`);
      if (p.faction !== null && !p.known) leaks.push(`座位${p.id} 的阵营被下发给了座位${v.me}`);
    }
  });
  if (v.transit && !v.transit.faceUp && v.transit.card) leaks.push('反面情报的牌面被下发');
}

function answerFor(p) {
  switch (p.kind) {
    case 'dialog': return p.options && p.options[0] ? p.options[0].value : 'ok';
    case 'pickHand': return p.allowCancel ? null : (p.cardIds[0] ?? null);
    case 'pickPlayer': return p.allowCancel ? null : (p.playerIds[0] ?? null);
    case 'cardList': return p.cards && p.cards.length ? p.cards[0].id : null;
    case 'action': return 'pass';
    case 'assassin': return false;
    default: return null;
  }
}

const guard = setTimeout(() => { console.log('（超时退出，共处理 ' + askCount + ' 次询问）'); process.exit(0); }, 600000);

ws.onopen = () => ws.send(JSON.stringify({ t: 'join', code, name: myName }));
ws.onerror = e => { console.error('WS ERROR', e.message || e); process.exit(1); };

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  switch (m.t) {
    case 'joined':
      me = m; console.log(`✓ 已加入房间 ${m.code}，座位 ${m.pid + 1} 号位（${myName}）`);
      break;
    case 'lobby':
      console.log('  大厅: ' + m.seats.map(s => `${s.idx + 1}号位 ${s.name}${s.connected === false ? '(断线)' : ''}${s.host ? ' [房主]' : ''}`).join(' | '));
      break;
    case 'gameStart': console.log('— 开局 —'); break;
    case 'view':
      viewCount++;
      leakCheck(m.view);
      if (viewCount === 1 && m.view) {
        const mine = m.view.players[m.view.me];
        console.log(`  我的阵营=${mine.faction} 角色=${mine.char} 手牌=${(mine.hand || []).map(c => c.name).join('/')}`);
      }
      break;
    case 'ask': {
      askCount++;
      const ans = answerFor(m.payload);
      if (m.payload.kind === 'dialog') console.log(`  [询问] ${strip(m.payload.title)} → 选「${ans}」`);
      else console.log(`  [询问] ${m.payload.kind} ${strip(m.payload.title || '')} → ${JSON.stringify(ans)}`);
      ws.send(JSON.stringify({ t: 'answer', qid: m.qid, ans }));
      break;
    }
    case 'log':
      logCount++;
      console.log(`${logCount}. ${strip(m.msg)}`);
      break;
    case 'declare':
      console.log(m.win ? '★ 我的阵营可宣胜（本测试不宣胜）' : '（宣胜机会关闭）');
      break;
    case 'over':
      clearTimeout(guard);
      console.log('\n=== 对局结束 ===', m.result.win.faction, '|', m.result.win.reason);
      console.log(leaks.length ? '✗ 视图泄露: ' + leaks.join('; ') : '✓ 视图过滤检查通过（无隐藏信息泄露）');
      console.log(`统计：询问=${askCount} 视图=${viewCount} 日志=${logCount}`);
      process.exit(leaks.length ? 2 : 0);
    case 'err': console.error('✗', m.msg); break;
  }
};
