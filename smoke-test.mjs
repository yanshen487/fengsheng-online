/* 无头冒烟测试：1 人类（本脚本，全自动应答）+ 3 AI，跑完整一局 */
const URL = process.env.URL || 'ws://localhost:8787';
const REMATCH = !!process.env.REMATCH;

const strip = s => String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
const ws = new WebSocket(URL);
let me = null, logCount = 0, viewCount = 0, askCount = 0, turns = 0, games = 0;

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

const guard = setTimeout(() => {
  console.error('\n✗ 超时：游戏 240 秒未结束（asks=' + askCount + ' logs=' + logCount + '）');
  process.exit(1);
}, 240000);

ws.onopen = () => ws.send(JSON.stringify({ t: 'create', name: '冒烟测试' }));
ws.onerror = e => { console.error('WS ERROR', e.message || e); process.exit(1); };

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  switch (m.t) {
    case 'joined':
      me = m; console.log('✓ 建房成功，房间号', m.code, '座位', m.pid);
      ws.send(JSON.stringify({ t: 'start' })); break;
    case 'meta':
      console.log('✓ meta:', Object.keys(m.meta.CHARS).map(k => m.meta.CHARS[k].name).join('/')); break;
    case 'gameStart':
      games++;
      console.log(games === 1 ? '— 开局 —' : '— 第 ' + games + ' 局开局（再来一局成功）—');
      if (REMATCH && games === 2) {
        clearTimeout(guard);
        console.log('✓ 重开一局验证通过');
        process.exit(0);
      }
      break;
    case 'log':
      logCount++;
      if (turns === 0 && /回合|开始/.test(m.msg)) { /* noop */ }
      console.log(logCount + '. ' + strip(m.msg));
      break;
    case 'view':
      viewCount++;
      if (m.view && m.view.turnCount > turns) turns = m.view.turnCount;
      break;
    case 'ask': {
      askCount++;
      ws.send(JSON.stringify({ t: 'answer', qid: m.qid, ans: answerFor(m.payload) }));
      break;
    }
    case 'declare':
      if (m.win) { console.log('★ 收到宣胜机会：' + m.win.reason); ws.send(JSON.stringify({ t: 'declare' })); }
      break;
    case 'over': {
      console.log('\n=== 对局结束 ===');
      console.log('胜者阵营:', m.result.win.faction, '|', m.result.win.reason);
      m.result.players.forEach(p => console.log(
        `  #${p.id} ${p.name.padEnd(10)} ${p.charName.padEnd(6)} ${p.faction.padEnd(8)} ${p.dead ? '死亡(' + p.deathCause + ')' : '存活'} ${p.isHuman ? '· 人类' : ''}`));
      console.log(`统计：回合≈${turns} 提问=${askCount} 视图=${viewCount} 日志=${logCount}`);
      if (REMATCH && games === 1) {
        console.log('↻ 请求再来一局…');
        ws.send(JSON.stringify({ t: 'rematch' }));
        break;
      }
      clearTimeout(guard);
      console.log('✓ 冒烟测试通过');
      process.exit(0);
    }
    case 'err': console.error('✗ 服务器错误:', m.msg); break;
    case 'askClose': break;
    case 'toast': break;
    case 'anim': break;
  }
};
