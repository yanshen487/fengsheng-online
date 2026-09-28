/* ================================================================
   风声 · 联机版引擎（服务器权威，无 DOM）
   规则移植自单机版《风声》，所有交互改为 io 适配器：
     io.ask(playerId, payload, def) -> Promise<answer>  向人类玩家提问
     io.pushView(playerId, view)                        推送该玩家私有视图
     io.log(msg, cls) / io.toast(html, ms) / io.anim(cue)
     io.declareOffer(playerId, win|null) / io.ended(result)
   引擎不接触任何网络细节，由 server.js 实现 io。
   ================================================================ */

export const FACTION = {
  junqing: {id:'junqing', name:'军情', color:'junqing'},
  qianfu:  {id:'qianfu',  name:'潜伏', color:'qianfu'},
  tegong:  {id:'tegong',  name:'特工', color:'tegong'},
};
export const FACTION_CSS = { junqing:'#2c5f8a', qianfu:'#9e2320', tegong:'#5a3b8a' };
export const COLOR = {
  red:  {id:'red',  name:'红', css:'red'},
  blue: {id:'blue', name:'蓝', css:'blue'},
  gray: {id:'gray', name:'灰', css:'gray'},
  redblue: {id:'redblue', name:'红蓝', css:'redblue'},
};
export const CODEWORDS = ['好人','卧底','盟友'];

export const CHARS = {
  xiaomage: {
    id:'xiaomage', name:'小马哥',
    skills:[
      {name:'英雄本色', desc:'回合开始抽牌时，若手牌<3张，可多抽等于自己存有假情报(灰)数量的牌。'},
      {name:'成仁取义', desc:'回合中可翻开身份并舍弃3张灰色手牌，将弃牌堆一张牌作为情报令一名玩家成功接收。'},
    ],
    secret:'牌堆首次抽完前，亲手杀死一名角色。',
    factionHint:''
  },
  xiaobai: {
    id:'xiaobai', name:'小白',
    skills:[
      {name:'乔装', desc:'回合开始抽牌前，可获取他人一项技能直至回合结束（对方暂时失去该技能）。'},
      {name:'收买', desc:'他人回合结束时，可给予对方4张手牌，然后选择对方一张情报成功接收。'},
    ],
    secret:'全场第一个死亡。',
  },
  fuping: {
    id:'fuping', name:'浮萍',
    skills:[
      {name:'闭月', desc:'抽牌阶段开始时可选：结束阶段摸1张，或摸4张并在结束阶段弃置所有手牌。'},
      {name:'牺牲', desc:'他人成功接收灰色情报时，可代替其接收该灰情报并摸2张牌。'},
    ],
    secret:'存有三张及以上真情报，且因存有三张假情报死亡。',
  },
  shashou: {
    id:'shashou', name:'职业杀手',
    skills:[
      {name:'雇佣关系', desc:'开局指定一名雇主并检视其阵营。雇主接收灰情报你弃1手牌；接收非灰情报你摸2张。'},
      {name:'暗杀', desc:'他人回合中，可烧毁自己一张非灰情报/弃3手牌，将一张灰手牌作情报令他人接收。'},
    ],
    secret:'亲手杀死一名与雇主不同阵营的玩家。',
  },
};

export const FUNC_KINDS = {
  '锁定':'suoding','截获':'jiehuo','转移':'zhuanyi','识破':'shipo',
  '调虎离山':'diaohu','秘密下达':'mimi','烧毁':'shaohui','试探':'shitan',
  '增援':'zengyuan','破译':'poyi'
};
export const CARD_DESC = {
  gongkai:'公开文本：当手牌用→指定玩家，你拿走其随机1手牌，此牌加入对方手牌。当情报→接收者按阵营摸牌。',
  diaobao:'调包：情报传回传出者时使用，用它顶替原情报（原情报入你手），传出者重传。',
  weixian:'危险情报：回合内打出→检视一名玩家手牌并弃置一张。',
  jimi:'机密文件：全场真情报≤3只能作情报；4-6张摸3；7张及以上摸5。',
  suoding:'锁定：自己回合使用，强制一名玩家接受传至他的情报。',
  jiehuo:'截获：回合外，他人情报接受时，将情报传至自己并进入接受。',
  zhuanyi:'转移：自己情报接受时，将情报传至他人接受。',
  shipo:'识破：令一张正在使用中的卡牌无效。',
  diaohu:'调虎离山：他人情报接受时取消其接受，情报按原顺序继续传递（不能对传出者用）。',
  mimi:'秘密下达：他人宣言传出时，强制其传出某颜色情报（听风/看雨/日落→蓝/红/灰）。',
  shaohui:'烧毁：任意时刻，移去一名玩家情报区的一张灰色情报。',
  shitan:'试探：自己回合使用，被试探玩家按其阵营“说我是xx”或“被抽一张手牌”。',
  zengyuan:'增援：自己回合使用，摸1张，自己每存有一张灰情报多摸1张。',
  poyi:'破译：场上有反面向上情报时，自己检视该情报。',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createEngine(io){
  /* ---------------- 全局状态 ---------------- */
  let G = null;
  let pendingDeclares = {}; // playerId -> win

  const shuffle = a => { for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
  const pick = arr => arr[Math.floor(Math.random()*arr.length)];

  function newGame(){
    G = {
      deck: [], discard: [],
      players: [],
      current: 0,
      codewords: {},
      deckFirstExhausted: false,
      gameOver: false,
      firstDeath: null,
      log: [],
      transit: null,
      turnCount: 0,
      killedRecord: {},
    };
  }

  // to: 仅这些座位可见；null = 全场可见
  function log(msg, cls, to){
    const entry = {msg, cls, to: to ? to.slice() : null};
    G.log.push(entry);
    if(G.log.length>200) G.log.shift();
    io.log(msg, cls, entry.to);
  }
  const pname = i => G.players[i].name;
  const alivePlayers = () => G.players.filter(p=>!p.dead);
  const nextIdx = i => (i+1)%G.players.length;
  const prevIdx = i => (i+3)%G.players.length;

  const intelColors = card => card.color==='redblue' ? ['red','blue'] : [card.color];
  const grayIntelCount = p => p.intel.filter(c=>c.color==='gray').length;
  const trueIntelCount = () => G.players.reduce((s,p)=>s+p.intel.filter(c=>c.color!=='gray').length,0);
  const nonGrayIntelCount = () => trueIntelCount();
  const nonGrayIntelCountOf = p => p.intel.filter(c=>c.color!=='gray').length;
  const colorIntelCount = (p, color) => p.intel.reduce((s,c)=>s+(intelColors(c).includes(color)?1:0),0);
  const redBlueTotal = p => p.intel.reduce((s,c)=>s+intelColors(c).length,0);

  const colorName = c => c==='redblue' ? '红蓝' : COLOR[c].name;

  /* ---------------- 牌堆 ---------------- */
  function drawFromDeck(){
    if(G.deck.length===0){
      if(!G.deckFirstExhausted){
        G.deckFirstExhausted=true;
        log('<b>⚠ 牌堆首次抽完！</b>','warn');
      }
      if(G.discard.length===0) return null;
      G.deck = shuffle(G.discard);
      G.discard = [];
      log('弃牌堆重新洗入牌堆。');
    }
    return G.deck.pop();
  }
  function drawCards(p, n){
    const got=[];
    for(let i=0;i<n;i++){ const c=drawFromDeck(); if(c) got.push(c); }
    p.hand.push(...got);
    return got;
  }
  function discardFromHand(p, card){
    const i=p.hand.indexOf(card);
    if(i>=0) p.hand.splice(i,1);
    G.discard.push(card);
  }
  function removeIntel(p, card){
    const i=p.intel.indexOf(card);
    if(i>=0) p.intel.splice(i,1);
    G.discard.push(card);
  }

  function buildDeck(){
    const d=[];
    let uid=0;
    const mk=(name,kind,color,method,rotate,lock,extra)=>{
      const c={id:uid++, name, kind, color, method, rotate:!!rotate, lock:!!lock};
      if(extra) Object.assign(c,extra);
      return c;
    };
    ['red','blue','gray'].forEach(c=>d.push(mk('公开文本','gongkai',c,'text',true,true)));
    ['red','blue','gray'].forEach(c=>d.push(mk('调包','diaobao',c,'text',true,true)));
    for(let i=0;i<2;i++) d.push(mk('危险情报','weixian','gray','any',false,true));
    Object.keys(FUNC_KINDS).forEach(name=>{
      for(let i=0;i<5;i++){
        d.push(mk(name,FUNC_KINDS[name], pick(['red','blue','gray']), pick(['cipher','direct']), false, false));
      }
    });
    for(let i=0;i<2;i++) d.push(mk('机密文件','jimi','redblue','direct',false,false));
    return shuffle(d);
  }

  /* ---------------- 技能判定 ---------------- */
  function hasSkill(p, name){
    if(!p) return false;
    const chars = CHARS[p.char];
    if(chars && chars.skills.some(s=>s.name===name)){
      const dis = (p.disabledSkill!==null && p.disabledSkill!==undefined) ? chars.skills[p.disabledSkill] : null;
      if(!(dis && dis.name===name)) return true;
    }
    if(p.borrowed){
      const from = G.players[p.borrowed.from];
      if(from){
        const sk = CHARS[from.char].skills[p.borrowed.skillIdx];
        if(sk && sk.name===name) return true;
      }
    }
    return false;
  }
  function knowsFaction(decider, target){
    if(!decider || !target) return false;
    if(decider.id===target.id) return true;
    if(target.factionRevealed) return true;
    return decider.factionKnownBy.has(target.id);
  }

  /* ---------------- 视图序列化 ---------------- */
  const cardView = c => c ? {id:c.id, name:c.name, kind:c.kind, color:c.color, method:c.method, rotate:!!c.rotate, lock:!!c.lock} : null;

  function buildView(vid, full){
    const me = G.players[vid];
    const v = {
      me: vid,
      current: G.current,
      turnCount: G.turnCount,
      gameOver: G.gameOver,
      deckCount: G.deck.length,
      discardCount: G.discard.length,
      transit: G.transit ? {
        sender: G.transit.sender,
        method: G.transit.method,
        direction: G.transit.direction,
        directTarget: G.transit.directTarget,
        faceUp: G.transit.faceUp,
        card: G.transit.faceUp ? cardView(G.transit.card) : null,
      } : null,
      players: G.players.map(p => {
        const known = (p.id===vid) || knowsFaction(me, p);
        return {
          id: p.id, name: p.name, char: p.char, dead: p.dead, isHuman: p.isHuman,
          handCount: p.hand.length,
          intel: p.intel.map(cardView),
          known,
          faction: known ? p.faction : null,
          employer: (p.employer!==null && p.employer!==undefined && (p.id===vid || p.employer===vid)) ? p.employer : null,
          hand: (p.id===vid) ? p.hand.map(cardView) : null,
        };
      }),
    };
    if(full) v.log = G.log.filter(e=>!e.to || e.to.includes(vid)).map(e=>({msg:e.msg, cls:e.cls})).slice(-120);
    return v;
  }
  function render(){
    if(!G) return;
    G.players.forEach(p=>io.pushView(p.id, buildView(p.id, false)));
  }

  /* ---------------- io 交互包装 ---------------- */
  function showDialog(p, title, html, options, def){
    return io.ask(p.id, {kind:'dialog', title, html, options}, def===undefined ? options[0].value : def);
  }
  async function selectHandCard(p, filter, allowCancel=false){
    if(!p.isHuman) return aiSelectCard(p, filter);
    const ids = p.hand.filter(c=>filter?filter(c):true).map(c=>c.id);
    if(ids.length===0) return null;
    const def = allowCancel ? null : ids[0];
    const ans = await io.ask(p.id, {kind:'pickHand', title:'选择手牌', cardIds:ids, allowCancel}, def);
    if(ans===null) return null;
    const c = p.hand.find(x=>x.id===ans && ids.includes(x.id));
    return c || (allowCancel ? null : p.hand.find(x=>x.id===ids[0]));
  }
  async function selectPlayer(p, filter, allowCancel=false){
    if(!p.isHuman) return aiSelectPlayer(p, filter);
    const ids = G.players.filter(pp=>!pp.dead && pp.id!==p.id && (filter?filter(pp):true)).map(pp=>pp.id);
    if(ids.length===0) return null;
    const def = allowCancel ? null : ids[0];
    const ans = await io.ask(p.id, {kind:'pickPlayer', title:'选择目标', playerIds:ids, allowCancel}, def);
    return (ans===null || !ids.includes(ans)) ? (allowCancel ? null : ids[0]) : ans;
  }
  async function askChoice(p, title, body, options){
    if(p.isHuman) return await io.ask(p.id, {kind:'dialog', title, html:body, options}, pick(options).value);
    return pick(options).value;
  }
  async function showCardList(p, cards, title){
    const ans = await io.ask(p.id, {kind:'cardList', title, cards:cards.map(cardView), allowCancel:true}, null);
    if(ans===null) return null;
    return cards.find(c=>c.id===ans) || null;
  }

  /* ---------------- 桌面动画（客户端演出指令） ---------------- */
  const paintFloatCard = card => io.anim({a:'floatNew', faceDown: !!(G.transit && !G.transit.faceUp), card: cardView(card)});
  const teleportFloatSeat = seat => io.anim({a:'floatTeleport', seat});
  async function animateFloatToSeat(seat, ms=460){ io.anim({a:'floatMove', seat, ms}); await sleep(ms); }
  const dropFloatCard = () => io.anim({a:'floatDrop'});
  function endTransit(){ G.transit=null; dropFloatCard(); render(); }

  const cardToast = (p, card, targetId) => {
    const t = (targetId!==null && targetId!==undefined) ? pname(targetId) : null;
    io.toast(t ? `<b>${p.name}</b> 打出【${card.name}】 → 目标 <b>${t}</b>` : `<b>${p.name}</b> 打出【${card.name}】`);
  };

  /* ---------------- 初始化 ---------------- */
  async function setupGame(seats){
    newGame();
    const factions = shuffle(['junqing','junqing','qianfu','qianfu','tegong']).slice(0,4);
    const chars = shuffle(Object.keys(CHARS));
    for(let i=0;i<4;i++){
      G.players.push({
        id:i, name: seats[i].name, isHuman: !!seats[i].isHuman,
        faction: factions[i], factionRevealed:false, factionKnownBy:new Set([i]),
        char: chars[i],
        hand:[], intel:[],
        dead:false, deathCause:'', killedBy:null,
        employer:null, biyue:null, borrowed:null, borrowFrom:null, disabledSkill:null,
      });
    }
    G.deck = buildDeck();
    G.players.forEach(p=>drawCards(p,2));
    G.current = Math.floor(Math.random()*4);
    log('<b>◆ 游戏开始 ◆</b> 四位谍战人员入座，逆时针顺序进行。');
    log(`由 <b>${pname(G.current)}</b> 先手。`);

    const killer = G.players.find(p=>p.char==='shashou');
    if(killer){
      const others = G.players.filter(p=>p.id!==killer.id);
      let emp;
      if(killer.isHuman){
        const opts = others.map(pp=>({label:pp.name, value:pp.id}));
        const choice = await io.ask(killer.id,
          {kind:'dialog', title:'雇佣关系', html:'作为职业杀手，请选择一名雇主（你将检视其阵营）：', options:opts},
          pick(others).id);
        emp = others.find(pp=>pp.id===choice) || pick(others);
      } else {
        emp = pick(others);
      }
      killer.employer = emp.id;
      killer.factionKnownBy.add(emp.id);
      log(`【雇佣关系】职业杀手 ${pname(killer.id)} 指定 ${pname(emp.id)} 为雇主，并检视其阵营。`);
      if(killer.isHuman){
        log(`<b>${killer.name} 检视到 ${pname(emp.id)} 的阵营是：${FACTION[emp.faction].name}</b>（仅其可见）。`, null, [killer.id]);
      }
    }
    render();
  }

  async function announceIdentities(){
    const humans = G.players.filter(p=>p.isHuman);
    await Promise.all(humans.map(p=>{
      const char = CHARS[p.char];
      const skillHtml = char.skills.map(s=>`<b>${s.name}</b>：${s.desc}`).join('<br>');
      const html = `<p>阵营：<b style="color:${FACTION_CSS[p.faction]};font-size:18px;">${FACTION[p.faction].name}</b></p>
       <p>角色：<b style="color:#2c5f8a;font-size:18px;">${char.name}</b></p>
       <p style="font-size:13px;line-height:1.7;">${skillHtml}</p>
       <p style="font-size:12px;color:#7a5a20;">秘密任务：${char.secret}</p>`;
      return io.ask(p.id, {kind:'dialog', title:'你的身份', html, options:[{label:'开始游戏', value:'ok', cls:'primary'}]}, 'ok');
    }));
  }

  /* ---------------- 胜负判定 ---------------- */
  function winningFactions(){
    const res=[];
    const jun = G.players.filter(p=>p.faction==='junqing');
    const qian = G.players.filter(p=>p.faction==='qianfu');
    const te = G.players.filter(p=>p.faction==='tegong');
    const junAlive = jun.filter(p=>!p.dead);
    const qianAlive = qian.filter(p=>!p.dead);
    const teAlive = te.filter(p=>!p.dead);

    if(junAlive.length){
      const by = junAlive.find(p=>colorIntelCount(p,'blue')>=3);
      if(by) res.push({faction:'junqing', reason:`军情玩家 ${pname(by.id)} 存有3张蓝色情报`, by:by.id});
      const othersDead = G.players.filter(p=>!p.dead && p.faction!=='junqing').length===0;
      if(othersDead) res.push({faction:'junqing', reason:'军情之外所有玩家均已死亡', by:junAlive[0].id});
    }
    if(qianAlive.length){
      const by = qianAlive.find(p=>colorIntelCount(p,'red')>=3);
      if(by) res.push({faction:'qianfu', reason:`潜伏玩家 ${pname(by.id)} 存有3张红色情报`, by:by.id});
      const othersDead = G.players.filter(p=>!p.dead && p.faction!=='qianfu').length===0;
      if(othersDead) res.push({faction:'qianfu', reason:'潜伏之外所有玩家均已死亡', by:qianAlive[0].id});
    }
    if(teAlive.length){
      const by = teAlive.find(p=>redBlueTotal(p)>=6);
      if(by) res.push({faction:'tegong', reason:`特工玩家 ${pname(by.id)} 红蓝情报之和达6张`, by:by.id});
      const othersDead = G.players.filter(p=>!p.dead && p.faction!=='tegong').length===0;
      if(othersDead) res.push({faction:'tegong', reason:'特工之外所有玩家均已死亡', by:teAlive[0].id});
    }
    return res;
  }

  function checkGameEnd(){
    if(G.gameOver) return;
    const wins = winningFactions();
    if(wins.length===0) return;
    const humanWinners = G.players.filter(p=>p.isHuman && wins.some(w=>w.faction===p.faction));
    if(humanWinners.length){
      humanWinners.forEach(p=>offerDeclare(p, wins.find(w=>w.faction===p.faction)));
    } else {
      endGame(wins[0]);
    }
  }
  function offerDeclare(p, w){
    if(G.gameOver) return;
    pendingDeclares[p.id] = w;
    io.declareOffer(p.id, {faction:w.faction, reason:w.reason, by:w.by});
    log(`<b>${p.name} 的阵营「${FACTION[w.faction].name}」已达成宣胜条件</b>（${w.reason}）。可选择宣胜，或继续游戏不宣胜。`,'win',[p.id]);
  }
  function endGame(w){
    G.gameOver = true;
    Object.keys(pendingDeclares).forEach(k=>io.declareOffer(Number(k), null));
    pendingDeclares = {};
    render();
    io.ended({
      win: {faction:w.faction, reason:w.reason, by:w.by},
      players: G.players.map(p=>({id:p.id, name:p.name, char:p.char, charName:CHARS[p.char].name, faction:p.faction, dead:p.dead, isHuman:p.isHuman, deathCause:p.deathCause})),
    });
  }
  function declare(playerId){
    if(!G || G.gameOver) return;
    const w = pendingDeclares[playerId];
    if(!w) return;
    const cur = winningFactions().find(x=>x.faction===G.players[playerId].faction);
    if(cur) endGame(cur);
    else { delete pendingDeclares[playerId]; io.declareOffer(playerId, null); render(); }
  }

  /* ---------------- 死亡判定 ---------------- */
  function checkDeath(p, killer){
    if(p.dead) return false;
    let die=false, cause='';
    if(grayIntelCount(p)>=3){ die=true; cause='存有3张灰色情报'; }
    if(die){
      p.dead=true; p.deathCause=cause; p.killedBy=killer;
      if(G.firstDeath===null) G.firstDeath=p.id;
      if(killer!==null && killer!==undefined) G.killedRecord[p.id]=killer;
      log(`<b>☠ ${pname(p.id)} 死亡出局！</b>（${cause}）`,'warn');
      if(G.firstDeath===p.id && p.char==='xiaobai'){
        log('【小白秘密任务】小白是全场第一个死亡，若为特工则完成秘密任务！','win');
        if(p.faction==='tegong'){
          endGame({faction:'tegong', reason:'小白(特工)成为全场第一个死亡，完成秘密任务', by:p.id});
        }
      }
      if(p.char==='fuping' && cause==='存有3张灰色情报' && p.faction==='tegong' && nonGrayIntelCountOf(p)>=3){
        log('【浮萍秘密任务】特工浮萍存有3张及以上真情报，因三张假情报死亡，完成秘密任务，仍可宣胜！','win');
        endGame({faction:'tegong', reason:'特工浮萍存有3张及以上真情报，因三张假情报死亡，完成秘密任务', by:p.id});
      }
      if(killer!==null && killer!==undefined){
        const kp = G.players[killer];
        if(kp && kp.char==='xiaomage' && !kp.dead && !G.deckFirstExhausted){
          log(`【小马哥秘密任务】${pname(killer)} 在牌堆首次抽完前亲手杀死一名角色，若为特工则完成秘密任务！`,'win');
          if(kp.faction==='tegong'){
            endGame({faction:'tegong', reason:'小马哥(特工)在牌堆首次抽完前亲手杀死一名角色，完成秘密任务', by:killer});
          }
        }
        if(kp && kp.char==='shashou' && !kp.dead && kp.employer!==null){
          const emp = G.players[kp.employer];
          if(emp && emp.faction !== p.faction){
            log(`【职业杀手秘密任务】${pname(killer)} 亲手杀死与雇主不同阵营的玩家，若为特工则完成秘密任务！`,'win');
            if(kp.faction==='tegong'){
              endGame({faction:'tegong', reason:'职业杀手(特工)亲手杀死雇主阵营外玩家，完成秘密任务', by:killer});
            }
          }
        }
      }
      render();
      return true;
    }
    return false;
  }

  /* ================================================================
     电脑 AI 决策
     ================================================================ */
  function aiSelectCard(p, filter){
    const candidates = p.hand.filter(c=>filter?filter(c):true);
    if(candidates.length===0) return null;
    return pick(candidates);
  }
  function aiSelectPlayer(p, filter){
    const cands = G.players.filter(pp=>!pp.dead && pp.id!==p.id && (filter?filter(pp):true));
    if(cands.length===0) return null;
    const enemies = cands.filter(pp=>knowsFaction(p, pp) && pp.faction!==p.faction);
    if(enemies.length && p.faction!=='tegong') return pick(enemies).id;
    return pick(cands).id;
  }
  function aiAcceptIntel(p, intel){
    const c=intel.card;
    const cols=intelColors(c);
    const gray = cols.includes('gray');
    if(gray) return false;
    if(c.kind==='gongkai') return true;
    if(intel.faceUp){
      if(p.faction==='junqing') return cols.includes('blue');
      if(p.faction==='qianfu')  return cols.includes('red');
      if(p.faction==='tegong')  return true;
      return false;
    } else {
      const s=G.players[intel.sender];
      if(knowsFaction(p, s)){
        if(s.faction===p.faction) return true;
        if(p.faction==='tegong') return Math.random()<0.5;
        return false;
      }
      if(p.faction==='tegong') return true;
      return Math.random()<0.35;
    }
  }
  function aiChooseIntel(p){
    if(p.faction==='junqing'){ const b=p.hand.find(c=>intelColors(c).includes('blue')&&c.color!=='gray'); if(b) return b; }
    if(p.faction==='qianfu'){ const r=p.hand.find(c=>intelColors(c).includes('red')&&c.color!=='gray'); if(r) return r; }
    if(p.faction==='tegong'){ const nb=p.hand.find(c=>c.color!=='gray'); if(nb) return nb; }
    const g=p.hand.find(c=>c.color==='gray');
    if(g) return g;
    return pick(p.hand);
  }
  async function aiPlayPhase(p){
    let c = p.hand.find(c=>c.kind==='zengyuan');
    if(c){ await playCardEffect(p,c,null); await sleep(450); }
    c = p.hand.find(c=>c.kind==='shitan');
    if(c){
      const t=aiSelectPlayer(p, pp=>true);
      if(t!==null){ await playCardEffect(p,c,{target:t}); await sleep(450); }
    }
    c = p.hand.find(c=>c.kind==='weixian');
    if(c){
      const t=aiSelectPlayer(p, pp=>knowsFaction(p, pp) && pp.faction!==p.faction);
      if(t!==null){ await playCardEffect(p,c,{target:t}); await sleep(450); }
    }
    c = p.hand.find(c=>c.kind==='shaohui');
    if(c){
      const target = G.players.find(pp=>!pp.dead && pp.intel.some(ic=>ic.color==='gray' && !ic.lock));
      if(target){ await playCardEffect(p,c,{target:target.id}); await sleep(450); }
    }
    if(canChengren(p)){ await effChengren(p); await sleep(450); }
  }
  const aiIntelPhase = p => doIntelTransmit(p);

  /* ================================================================
     卡牌效果
     ================================================================ */
  async function playCardEffect(p, card, opts){
    log(`<b>${p.name}</b> 打出【${card.name}】`);
    cardToast(p, card, opts && opts.target);
    const negated = await negateWindow(p, card);
    if(negated){
      discardFromHand(p, card);
      log(`【识破】${card.name} 被无效化。`);
      return;
    }
    const ok = await applyCardEffect(p, card, opts);
    if(ok === false){
      log(`<b>${p.name}</b> 保留了【${card.name}】。`);
    } else if(ok !== 'moved'){
      discardFromHand(p, card);
    }
    render();
  }
  async function applyCardEffect(p, card, opts){
    switch(card.kind){
      case 'gongkai': return effGongkai(p, card, opts);
      case 'weixian': return effWeixian(p, card, opts);
      case 'shaohui': return effShaohui(p, card, opts);
      case 'shitan': return effShitan(p, card, opts);
      case 'zengyuan': return effZengyuan(p);
      case 'poyi': return effPoyi(p);
      case 'jimi': return effJimi(p);
      case 'suoding':
      case 'jiehuo':
      case 'zhuanyi':
      case 'shipo':
      case 'diaohu':
      case 'mimi':
      case 'diaobao':
        log('该牌需在特定时机使用，此处不作为主动打出。');
        return false;
    }
    return false;
  }

  async function effGongkai(p, card, opts){
    let target = opts && opts.target!==undefined ? opts.target : await selectPlayer(p, pp=>true, p.isHuman);
    if(target===null) return false;
    const tp=G.players[target];
    if(tp.hand.length===0){ log(`${tp.name} 没有手牌。`); return false; }
    cardToast(p, card, target);
    const taken = tp.hand.splice(Math.floor(Math.random()*tp.hand.length),1)[0];
    p.hand.push(taken);
    const i=p.hand.indexOf(card);
    if(i>=0) p.hand.splice(i,1);
    tp.hand.push(card);
    log(`<b>${p.name}</b> 取走 ${tp.name} 一张手牌，并将【公开文本】塞给对方。`);
    return 'moved';
  }
  async function effWeixian(p, card, opts){
    let target = opts && opts.target!==undefined ? opts.target : await selectPlayer(p, pp=>true, p.isHuman);
    if(target===null) return false;
    const tp=G.players[target];
    if(tp.hand.length===0){ log(`${tp.name} 没有手牌。`); return false; }
    cardToast(p, card, target);
    let drop;
    if(p.isHuman){
      drop = await showCardList(p, tp.hand, `检视 ${tp.name} 的手牌，选择一张弃置`);
      if(drop===null) return false;
    } else {
      drop = pick(tp.hand);
    }
    discardFromHand(tp, drop);
    log(`<b>${p.name}</b> 检视 ${tp.name} 的手牌并弃置了一张【${drop.name}】。`);
    return true;
  }
  async function effShaohui(p, card, opts){
    let target = opts && opts.target!==undefined ? opts.target : await selectPlayer(p, pp=>pp.intel.some(ic=>ic.color==='gray' && !ic.lock), p.isHuman);
    if(target===null) return false;
    const tp=G.players[target];
    const grays = tp.intel.filter(ic=>ic.color==='gray' && !ic.lock);
    if(grays.length===0){ log(`${tp.name} 没有可烧毁的灰色情报。`); return false; }
    cardToast(p, card, target);
    let burn;
    if(p.isHuman){
      burn = await showCardList(p, grays, `选择要烧毁 ${tp.name} 的一张灰色情报`);
      if(burn===null) return false;
    } else burn = pick(grays);
    removeIntel(tp, burn);
    log(`<b>${p.name}</b> 烧毁了 ${tp.name} 情报区的一张灰色情报【${burn.name}】。`);
    return true;
  }
  async function effShitan(p, card, opts){
    let target = opts && opts.target!==undefined ? opts.target : await selectPlayer(p, pp=>true, p.isHuman);
    if(target===null) return false;
    const tp=G.players[target];
    cardToast(p, card, target);
    const perm = shuffle(CODEWORDS.slice());
    const map = { junqing: perm[0], qianfu: perm[1], tegong: perm[2] };
    const code = map[tp.faction];
    const factionByCode = {};
    ['junqing','qianfu','tegong'].forEach(f=>{ factionByCode[map[f]] = f; });

    if(p.isHuman){
      await showDialog(p, '试探·暗号对应',
        '本张【试探】的暗号对应（仅你与目标可见）：<br>好人 → <b>'+FACTION[factionByCode['好人']].name+'</b><br>卧底 → <b>'+FACTION[factionByCode['卧底']].name+'</b><br>盟友 → <b>'+FACTION[factionByCode['盟友']].name+'</b>',
        [{label:'知道了', value:'ok'}], 'ok');
    }

    const choice = await askChoice(tp,
      '被试探！',
      `<b>${p.name}</b> 对你使用【试探】。本张试探中你的阵营对应暗号「<b>${code}</b>」。你可选择：<br>① 说“我是${code}”<br>② 被抽走一张随机手牌`,
      [{label:`说“我是${code}”`, value:'say'},{label:'被抽一张手牌', value:'draw'}]
    );

    if(choice==='say'){
      log(`<b>${tp.name}</b> 宣布：“我是${code}”。`);
      p.factionKnownBy.add(tp.id);
      if(p.isHuman){
        await showDialog(p, '试探结果',
          '本张试探中「'+code+'」对应 <b>'+FACTION[factionByCode[code]].name+'</b>，因此 <b>'+tp.name+'</b> 是 <b>'+FACTION[tp.faction].name+'</b>！',
          [{label:'知道了', value:'ok'}], 'ok');
      }
    } else {
      if(tp.hand.length>0){
        const taken=tp.hand.splice(Math.floor(Math.random()*tp.hand.length),1)[0];
        p.hand.push(taken);
        log(`<b>${tp.name}</b> 选择被抽牌，${p.name} 抽走其一张手牌。`);
      } else log(`${tp.name} 没有手牌可被抽。`);
    }
    return true;
  }
  async function effZengyuan(p){
    const n=1+grayIntelCount(p);
    drawCards(p,n);
    log(`<b>${p.name}</b> 使用增援，摸 ${n} 张牌。`);
    return true;
  }
  async function effPoyi(p){
    if(!G.transit || G.transit.faceUp){ log('当前没有反面向上的情报可破译。'); return false; }
    const c=G.transit.card;
    log(`<b>${p.name}</b> 使用【破译】检视了正在传递的反面情报（内容仅其可见）。`);
    if(p.isHuman){
      await showDialog(p, '破译', '你检视到该反面情报为：<b>'+c.name+'</b>（'+colorName(c.color)+'）', [{label:'知道了', value:'ok'}], 'ok');
    }
    return true;
  }
  async function effJimi(p){
    const n=trueIntelCount();
    if(n<=3){ log(`当前全场真情报 ${n} 张（≤3），机密文件只能作情报传出。`); return false; }
    const draw = (n>=7) ? 5 : 3;
    drawCards(p,draw);
    log(`<b>${p.name}</b> 打出机密文件，摸 ${draw} 张牌。`);
    return true;
  }

  /* ---------------- 识破窗口 ---------------- */
  async function negateWindow(user, card){
    for(let i=0;i<G.players.length;i++){
      const p=G.players[i];
      if(p.id===user.id || p.dead) continue;
      const shipo = p.hand.find(c=>c.kind==='shipo');
      if(!shipo) continue;
      let want=false;
      if(p.isHuman){
        const r = await showDialog(p, '识破机会', `<b>${user.name}</b> 正在使用【${card.name}】。你要用【识破】使其无效吗？`,
          [{label:'识破！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no');
        want = r==='yes';
      } else {
        want = ['suoding','jiehuo','zhuanyi','shipo','mimi','shitan','shaohui'].includes(card.kind) && Math.random()<0.4;
      }
      if(want){
        discardFromHand(p, shipo);
        log(`<b>${p.name}</b> 使用【识破】！`);
        return true;
      }
    }
    return false;
  }

  /* ================================================================
     情报传递
     ================================================================ */
  async function doIntelTransmit(p){
    let card;
    if(p.hand.length===0){
      card=drawFromDeck();
      if(!card){ log('牌堆与弃牌堆均无牌，无法传递情报。'); return; }
      log(`<b>${p.name}</b> 无手牌，从牌堆顶抽一张作为情报。`);
    } else {
      if(p.isHuman){
        card = await selectHandCard(p, c=>true, false);
      } else {
        card = aiChooseIntel(p);
      }
    }
    if(!card){ log('未选择情报，跳过传递。'); return; }
    const hi=p.hand.indexOf(card);
    if(hi>=0) p.hand.splice(hi,1);

    const forced = await secretOrderWindow(p, card);
    if(forced!==null){
      const targetColor = forced;
      const has = p.hand.find(c=>intelColors(c).includes(targetColor));
      if(has){
        p.hand.push(card);
        card=has;
        p.hand.splice(p.hand.indexOf(has),1);
        log(`【秘密下达】${p.name} 被迫改传 ${COLOR[targetColor].name} 色情报。`);
      } else {
        log(`【秘密下达】${p.name} 无 ${COLOR[targetColor].name} 色手牌，被检视手牌，秘密下达失效。`);
      }
    }

    let method=card.method;
    if(method==='any'){
      if(p.isHuman){
        method = await showDialog(p, '选择传递方式', '危险情报可选传递方式：',
          [{label:'文本（正面朝上）', value:'text'},{label:'密电（反面朝上）', value:'cipher'},{label:'直达（直接传递）', value:'direct'}], 'cipher');
      } else {
        method = 'cipher';
      }
    }
    let direction='ccw';
    if(card.rotate && method!=='direct'){
      if(p.isHuman){
        direction = await showDialog(p, '选择方向', '该牌带旋转标记，选择传递方向：',
          [{label:'逆时针', value:'ccw'},{label:'顺时针', value:'cw'}], 'ccw');
      } else direction=pick(['ccw','cw']);
    }
    let directTarget=null;
    if(method==='direct'){
      directTarget = await selectPlayer(p, pp=>true, p.isHuman);
      if(directTarget===null){ p.hand.push(card); log('取消直达，情报收回。'); return; }
    }

    const tTail = `（${methodName(method)}${method!=='direct'?'·'+directionName(direction):''}）`;
    const tDir = method==='direct' ? ('→ '+pname(directTarget)) : '';
    log(method==='text'
      ? `<b>${p.name}</b> 传出情报【${card.name}】${tDir}${tTail}。`
      : `<b>${p.name}</b> 传出一张反面情报${tDir}${tTail}。`);

    io.toast(method==='direct'
      ? `<b>${p.name}</b> 开始传递情报 · <b>${methodName(method)}</b> → ${pname(directTarget)}`
      : `<b>${p.name}</b> 开始传递情报 · <b>${methodName(method)}</b> · <b>${directionName(direction)}</b>`);

    await runIntelTransfer(p.id, card, method, direction, directTarget);
  }
  const methodName = m => m==='text'?'文本':m==='cipher'?'密电':m==='direct'?'直达':'任选';
  const directionName = d => d==='cw'?'顺时针':'逆时针';

  /* ---------------- 秘密下达 ---------------- */
  async function secretOrderWindow(sender, card){
    for(let i=0;i<G.players.length;i++){
      const p=G.players[i];
      if(p.id===sender.id || p.dead) continue;
      const mimi = p.hand.find(c=>c.kind==='mimi');
      if(!mimi) continue;
      let use=false, color=null;
      if(p.isHuman){
        const r = await io.ask(p.id,
          {kind:'dialog', title:'秘密下达', html:`<b>${sender.name}</b> 即将传出情报。是否使用【秘密下达】强制其传出某颜色？`,
           options:[{label:'强制蓝（听风）', value:'blue'},{label:'强制红（看雨）', value:'red'},{label:'强制灰（日落）', value:'gray'},{label:'不用', value:null}]},
          null);
        if(r!==null){ use=true; color=r; }
      } else {
        if(knowsFaction(p, sender) && sender.faction!==p.faction && Math.random()<0.5){
          use=true; color='gray';
        }
      }
      if(use){
        discardFromHand(p,mimi);
        log(`<b>${p.name}</b> 使用【秘密下达】强制 ${sender.name} 传出 ${COLOR[color].name} 色情报。`);
        return color;
      }
    }
    return null;
  }

  /* ---------------- 破译窗口 ---------------- */
  async function poyiWindow(sender){
    if(!G.transit) return;
    if(G.transit.method==='text') return;
    for(let i=0;i<G.players.length;i++){
      const q=G.players[i];
      if(q.id===sender || q.dead) continue;
      const po = q.hand.find(c=>c.kind==='poyi');
      if(!po) continue;
      let use=false;
      if(q.isHuman){
        use = (await showDialog(q, '破译机会', '场上有<b>'+methodName(G.transit.method)+'</b>情报正在传递。要用【破译】检视它吗？',
          [{label:'破译！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no'))==='yes';
      } else {
        use = Math.random()<0.4;
      }
      if(use){
        discardFromHand(q, po);
        const c=G.transit.card;
        log(`<b>${q.name}</b> 使用【破译】检视了正在传递的反面情报（内容仅其可见）。`);
        if(q.isHuman){
          await showDialog(q, '破译', '你检视到该情报为：<b>'+c.name+'</b>（'+colorName(c.color)+'）', [{label:'知道了', value:'ok'}], 'ok');
        }
      }
    }
  }

  /* ---------------- 传递循环 ---------------- */
  async function runIntelTransfer(sender, card, method, direction, directTarget){
    const n=G.players.length;
    let order=[];
    if(method==='direct'){
      order = directTarget===sender ? [sender] : [directTarget, sender];
    } else {
      let i=sender; const step = direction==='cw' ? -1 : 1;
      do{
        i=(i+step+n)%n;
        order.push(i);
      }while(i!==sender);
    }
    G.transit = {card, faceUp: method==='text', sender, method, direction, directTarget};
    render();
    paintFloatCard(card);
    teleportFloatSeat(sender);
    await sleep(260);
    await poyiWindow(sender);

    for(let k=0;k<order.length;k++){
      const r=order[k];
      if(G.gameOver) return;
      await animateFloatToSeat(r, 460);
      await sleep(180);
      if(r===sender){
        const swapped = await diaobaoWindow(sender);
        if(swapped){
          endTransit();
          log(`【调包】正在传递的情报被替换，<b>${pname(sender)}</b> 需重新传递一张反面情报。`);
          await runIntelTransfer(sender, swapped, swapped.method==='any'?'cipher':swapped.method, direction, directTarget);
          return;
        }
        await finalizeIntel(sender, G.transit.card, sender);
        endTransit();
        return;
      }
      const accepts = await askAccept(r, G.transit);
      if(accepts){
        const outcome = await acceptWindow(r, G.transit.card, sender);
        if(outcome.type==='finalize'){
          await finalizeIntel(outcome.acceptor, outcome.card, sender);
          endTransit();
          return;
        } else if(outcome.type==='cancel'){
          log('【调虎离山】该玩家接受被取消，情报继续传递。');
          continue;
        } else if(outcome.type==='redirect' || outcome.type==='done'){
          endTransit();
          return;
        }
      }
    }
    endTransit();
  }

  /* ---------------- 询问是否接受 ---------------- */
  async function askAccept(r, transit){
    const p=G.players[r];
    const turnP=G.players[G.current];
    if(turnP && !turnP.dead && turnP.id!==r){
      const suoding = turnP.hand.find(c=>c.kind==='suoding');
      if(suoding){
        let use=false;
        if(turnP.isHuman){
          use = (await showDialog(turnP, '锁定', `<b>${p.name}</b> 正面临情报传递。是否用【锁定】强制其接受？`,
            [{label:'锁定！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no'))==='yes';
        } else {
          use = transit.card.color==='gray' && knowsFaction(turnP, p) && p.faction!==turnP.faction && Math.random()<0.6;
        }
        if(use){
          discardFromHand(turnP, suoding);
          log(`<b>${turnP.name}</b> 使用【锁定】强制 ${p.name} 接受情报！`);
          return true;
        }
      }
    }
    if(p.isHuman){
      const faceDown=!transit.faceUp;
      const c=transit.card;
      const shown = faceDown ? '（反面朝上，未知颜色）' : `【${c.name}】${colorName(c.color)}色`;
      return (await showDialog(p, '接收情报？', `<b>${pname(transit.sender)}</b> 传来的情报 ${shown}。是否接受？`,
        [{label:'接受', value:'accept', cls:'green'},{label:'拒绝，继续传', value:'refuse', cls:''}], 'refuse'))==='accept';
    } else {
      return aiAcceptIntel(p, transit);
    }
  }

  /* ---------------- 接受时窗口（截获/转移/调虎离山/牺牲） ---------------- */
  async function acceptWindow(acceptor, card, sender, depth=0){
    if(depth>6) return {type:'finalize', acceptor, card};
    const p=G.players[acceptor];

    for(let i=0;i<G.players.length;i++){
      const q=G.players[i];
      if(q.id===acceptor || q.dead) continue;
      const jie=q.hand.find(c=>c.kind==='jiehuo');
      if(!jie) continue;
      let use=false;
      if(q.isHuman){
        use = (await showDialog(q, '截获机会', `<b>${p.name}</b> 正在接受情报。你要用【截获】将情报传至自己吗？`,
          [{label:'截获！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no'))==='yes';
      } else {
        const cols=intelColors(card);
        const good = (q.faction==='junqing'&&cols.includes('blue'))||(q.faction==='qianfu'&&cols.includes('red'))||(q.faction==='tegong'&&!cols.includes('gray'));
        use = good && Math.random()<0.7;
      }
      if(use){
        discardFromHand(q,jie);
        log(`<b>${q.name}</b> 使用【截获】，情报传至自己！`);
        io.toast(`<b>${q.name}</b> 使用【截获】，情报传至自己！`);
        await animateFloatToSeat(q.id, 520);
        const sub = await acceptWindow(q.id, card, sender, depth+1);
        if(sub.type==='finalize') return sub;
        if(sub.type==='cancel') return sub;
        if(sub.type==='redirect') return sub;
        return {type:'redirect'};
      }
    }

    await sleep(380);
    const zy = p.hand.find(c=>c.kind==='zhuanyi');
    if(zy){
      let use=false, target=null;
      if(p.isHuman){
        const t=await selectPlayer(p, pp=>true, true);
        if(t!==null){ use=true; target=t; }
      } else {
        use = Math.random()<0.3; target = aiSelectPlayer(p, pp=>true);
      }
      if(use && target!==null){
        discardFromHand(p,zy);
        log(`<b>${p.name}</b> 使用【转移】，将情报转给 ${pname(target)}。`);
        io.toast(`<b>${p.name}</b> 使用【转移】 → ${pname(target)}`);
        await animateFloatToSeat(target, 520);
        const sub = await acceptWindow(target, card, sender, depth+1);
        if(sub.type==='finalize') return sub;
        if(sub.type==='cancel') return sub;
        return {type:'redirect'};
      }
    }

    await sleep(380);
    for(let i=0;i<G.players.length;i++){
      const q=G.players[i];
      if(q.id===acceptor || q.id===sender || q.dead) continue;
      const dh=q.hand.find(c=>c.kind==='diaohu');
      if(!dh) continue;
      let use=false;
      if(q.isHuman){
        use = (await showDialog(q, '调虎离山', `<b>${p.name}</b> 正在接受情报。要用【调虎离山】取消其接受、让情报继续传吗？`,
          [{label:'调虎离山！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no'))==='yes';
      } else {
        use = knowsFaction(q, p) && p.faction!==q.faction && Math.random()<0.5;
      }
      if(use){
        discardFromHand(q,dh);
        log(`<b>${q.name}</b> 使用【调虎离山】，${p.name} 的接受被取消！`);
        io.toast(`<b>${q.name}</b> 使用【调虎离山】，取消 ${p.name} 的接受`);
        return {type:'cancel'};
      }
    }

    await sleep(380);
    if(card.color==='gray'){
      const fp=G.players.find(pp=>hasSkill(pp,'牺牲') && !pp.dead && pp.id!==acceptor);
      if(fp){
        let use=false;
        if(fp.isHuman){
          use = (await showDialog(fp, '牺牲', `<b>${p.name}</b> 即将接收灰色情报。你要【牺牲】代其接收并摸2张吗？`,
            [{label:'牺牲！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no'))==='yes';
        } else {
          use = true;
        }
        if(use){
          log(`<b>${fp.name}</b>【牺牲】，代替 ${p.name} 接收灰色情报！`);
          fp.intel.push(card);
          drawCards(fp,2);
          log(`${fp.name} 接收灰色情报并摸2张牌。`);
          await animateFloatToSeat(fp.id, 520);
          dropFloatCard();
          checkDeath(fp, sender);
          render();
          if(!G.gameOver) checkGameEnd();
          return {type:'done'};
        }
      }
    }

    return {type:'finalize', acceptor, card};
  }

  /* ---------------- 调包窗口 ---------------- */
  async function diaobaoWindow(sender){
    for(let i=0;i<G.players.length;i++){
      const p=G.players[i];
      if(p.dead) continue;
      const db=p.hand.find(c=>c.kind==='diaobao');
      if(!db) continue;
      let use=false;
      if(p.isHuman){
        use = (await showDialog(p, '调包机会', `情报已传回 <b>${pname(sender)}</b>。要用【调包】替换该情报吗？（原情报入你手，传出者重传调包）`,
          [{label:'调包！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no'))==='yes';
      } else {
        const good=(sender===i)?false:((knowsFaction(p, G.players[sender]) && G.players[sender].faction!==p.faction)&&Math.random()<0.5);
        use = good;
      }
      if(use){
        p.hand.push(G.transit.card);
        discardFromHand(p, db);
        log(`<b>${p.name}</b> 使用【调包】，原情报入其手牌，改为传递一张反面情报。`);
        io.toast(`<b>${p.name}</b> 使用【调包】，替换正在传递的情报`);
        return db;
      }
    }
    return null;
  }

  /* ---------------- 情报落定 ---------------- */
  async function finalizeIntel(acceptor, card, sender){
    const p=G.players[acceptor];
    log(`<b>${p.name}</b> 成功接收情报【${card.name}】${card.color==='redblue'?'（红蓝共存）':'（'+COLOR[card.color].name+'色）'}。`);
    io.toast(`<b>${p.name}</b> 成功接收情报 · <b>${card.color==='redblue'?'红蓝':COLOR[card.color].name+'色'}</b>`);
    p.intel.push(card);
    await animateFloatToSeat(acceptor, 540);
    await sleep(120);
    dropFloatCard();

    if(card.kind==='gongkai'){
      await gongkaiReceiveEffect(p, card);
    }
    const killer = G.players.find(k=>hasSkill(k,'雇佣关系') && !k.dead && k.employer===acceptor);
    if(killer && killer.id!==acceptor){
      if(card.color==='gray'){
        if(killer.hand.length>0){
          const dc=killer.hand.splice(Math.floor(Math.random()*killer.hand.length),1)[0];
          G.discard.push(dc);
          log(`【雇佣关系】职业杀手 ${killer.name} 因雇主接收灰情报弃一张手牌。`);
        }
      } else {
        drawCards(killer,2);
        log(`【雇佣关系】职业杀手 ${killer.name} 因雇主接收非灰情报摸2张牌。`);
      }
    }

    checkDeath(p, sender);
    render();
    if(!G.gameOver) checkGameEnd();
  }

  async function gongkaiReceiveEffect(p, card){
    const f=p.faction; const c=card.color;
    let opts;
    if(c==='red'){
      opts = {junqing:[1,2], qianfu:[1], tegong:[1,2]};
    } else if(c==='blue'){
      opts = {junqing:[1], qianfu:[1,2], tegong:[1,2]};
    } else {
      opts = {junqing:[1,2], qianfu:[1,2], tegong:[1]};
    }
    const choices=opts[f];
    let n;
    if(choices.length===1) n=choices[0];
    else {
      if(p.isHuman){
        n = await showDialog(p, '公开文本效果', '你接收了公开文本，选择摸牌数量：',
          [{label:'摸1张', value:1},{label:'摸2张', value:2}], 2);
      } else n=2;
    }
    drawCards(p,n);
    log(`<b>${p.name}</b> 因接收公开文本摸 ${n} 张牌。`);
  }

  /* ================================================================
     回合内的角色技能钩子
     ================================================================ */
  async function startTurnHooks(p){
    if(p.dead) return;
    if(p.char==='xiaobai'){
      const targets = G.players.filter(pp=>!pp.dead && pp.id!==p.id);
      if(targets.length){
        let use=false, target=null, skillIdx=0;
        if(p.isHuman){
          while(true){
            const t=await selectPlayer(p, pp=>true, true);
            if(t===null) break;
            const sk = await showDialog(p, '乔装',
              '选择要借取 '+pname(t)+' 的哪项技能（对方本回合失去该技能）：',
              [{label:CHARS[G.players[t].char].skills[0].name, value:0},{label:CHARS[G.players[t].char].skills[1].name, value:1},{label:'取消', value:null}],
              null);
            if(sk!==null){ use=true; target=t; skillIdx=sk; break; }
          }
        } else {
          use=Math.random()<0.6; target=pick(targets).id; skillIdx=pick([0,1]);
        }
        if(use && target!==null){
          const tp=G.players[target];
          p.borrowed={from:tp.id, skillIdx};
          p.borrowFrom=tp.id;
          tp.disabledSkill=skillIdx;
          log(`【乔装】${p.name} 借取 ${tp.name} 的技能「${CHARS[tp.char].skills[skillIdx].name}」直至回合结束。`);
        }
      }
    }
  }

  async function drawPhase(p){
    if(p.dead) return;
    if(hasSkill(p,'闭月')){
      let choice;
      if(p.isHuman){
        choice = await showDialog(p, '闭月', '抽牌阶段开始，选择你的闭月效果：',
          [{label:'结束阶段摸1张', value:'one'},{label:'摸4张并在结束阶段弃光手牌', value:'four'}], 'one');
      } else {
        choice = pick(['one','four']);
      }
      p.biyue=choice;
      log(`【闭月】${p.name} 选择：${choice==='one'?'结束阶段摸1张':'摸4张并在结束阶段弃光手牌'}。`);
    }
    let extra=0;
    if(hasSkill(p,'英雄本色') && p.hand.length<3){
      extra = grayIntelCount(p);
      if(extra>0){
        let use=false;
        if(p.isHuman){
          use = (await showDialog(p, '英雄本色', `你手牌 ${p.hand.length} 张<3，可多抽 ${extra} 张（=你的灰情报数）。`,
            [{label:`多抽 ${extra} 张`, value:'yes', cls:'primary'},{label:'不抽', value:'no'}], 'yes'))==='yes';
        } else use=true;
        if(use) log(`【英雄本色】${p.name} 多抽 ${extra} 张。`);
        else extra=0;
      }
    }
    let base = 2;
    if(hasSkill(p,'闭月') && p.biyue==='four') base = 4;
    drawCards(p, base+extra);
    log(`<b>${p.name}</b> 抽牌阶段摸 ${base+extra} 张牌。`);
  }

  async function playPhase(p){
    if(p.dead) return;
    if(p.isHuman){
      let guard=0;
      while(true){
        render();
        const playable = p.hand.filter(c=>playableInHand(c));
        const ans = await io.ask(p.id, {
          kind:'action',
          playableIds: playable.map(c=>c.id),
          canChengren: canChengren(p),
        }, 'pass');
        const a = (typeof ans==='string') ? {a:ans} : (ans||{a:'pass'});
        if(a.a==='pass') break;
        if(a.a==='chengren'){
          if(canChengren(p)){ await effChengren(p); render(); }
          continue;
        }
        if(a.a==='play'){
          const card = p.hand.find(c=>c.id===a.cardId);
          if(!card || !playableInHand(card)){ if(++guard>3) break; continue; }
          await playCardEffect(p, card, null);
          render();
          continue;
        }
        break;
      }
    } else {
      await aiPlayPhase(p);
    }
  }
  function playableInHand(card){
    if(!['gongkai','weixian','shaohui','shitan','zengyuan','jimi'].includes(card.kind)) return false;
    if(card.kind==='shaohui' && !G.players.some(p=>!p.dead && p.intel.some(c=>c.color==='gray' && !c.lock))) return false;
    return true;
  }

  async function intelPhase(p){
    if(p.dead) return;
    if(p.isHuman){
      render();
      await io.ask(p.id, {kind:'dialog', title:'情报传递阶段',
        html:'请从手牌选择一张作为“情报”传出（若无可从牌堆顶抽）。点击手牌即可选择。',
        options:[{label:'知道了', value:'ok'}]}, 'ok');
      await doIntelTransmit(p);
    } else {
      await aiIntelPhase(p);
    }
  }

  async function endPhase(p){
    if(p.dead) return;
    if(hasSkill(p,'闭月') && p.biyue){
      if(p.biyue==='one'){
        drawCards(p,1);
        log(`【闭月】${p.name} 结束阶段摸1张。`);
      } else {
        while(p.hand.length){ G.discard.push(p.hand.pop()); }
        log(`【闭月】${p.name} 结束阶段弃光所有手牌。`);
      }
      p.biyue=null;
    }
    if(p.hand.length>6){
      let drop=p.hand.length-6;
      for(let i=0;i<drop;i++){
        let c;
        if(p.isHuman){
          c = await selectHandCard(p, cc=>true, false);
        } else {
          c = pick(p.hand);
        }
        if(!c) break;
        discardFromHand(p,c);
      }
      log(`<b>${p.name}</b> 弃至6张手牌。`);
    }
    render();

    const xb = G.players.find(pp=>hasSkill(pp,'收买') && !pp.dead && pp.id!==p.id);
    if(xb && p.id!==xb.id && xb.hand.length>=4 && p.intel.length>0){
      let use=false, stolen=null;
      if(xb.isHuman){
        const s = await showDialog(xb, '收买', `<b>${p.name}</b> 回合结束。是否【收买】其一张情报？（付4张手牌）`,
          [{label:'收买！', value:'yes', cls:'primary'},{label:'不', value:'no'}], 'no');
        if(s==='yes'){
          stolen = await showCardList(xb, p.intel, '选择要收买接收的情报');
        }
        use = s==='yes' && stolen;
      } else {
        const good = p.intel.find(c=>intelColors(c).includes(xb.faction==='junqing'?'blue':xb.faction==='qianfu'?'red':'blue'));
        if(good && xb.hand.length>=4){ use=true; stolen=good; }
      }
      if(use && stolen){
        for(let i=0;i<4;i++){ if(xb.hand.length) discardFromHand(xb, xb.hand[0]); }
        removeIntel(p, stolen);
        xb.intel.push(stolen);
        log(`【收买】${xb.name} 付4张手牌，收买了 ${p.name} 的一张情报【${stolen.name}】。`);
        checkDeath(xb, xb.id);
        if(!G.gameOver) checkGameEnd();
      }
    }
  }

  /* ================================================================
     成仁取义 / 暗杀
     ================================================================ */
  function canChengren(p){
    if(!hasSkill(p,'成仁取义') || p.dead) return false;
    if(p.hand.filter(c=>c.color==='gray').length<3) return false;
    if(G.discard.length===0) return false;
    return true;
  }
  async function effChengren(p){
    const grays = p.hand.filter(c=>c.color==='gray').slice(0,3);
    if(grays.length<3) return;
    let card;
    if(p.isHuman) card = await showCardList(p, G.discard.slice(), '选择弃牌堆一张牌作为情报');
    else card = G.discard.find(c=>c.color==='gray') || G.discard[G.discard.length-1];
    if(!card) return;
    const target = await selectPlayer(p, pp=>true, p.isHuman);
    if(target===null) return;

    p.factionRevealed=true;
    log(`<b>${p.name}</b> 翻开身份（${FACTION[p.faction].name}）。`);
    grays.forEach(c=>discardFromHand(p,c));
    const di=G.discard.indexOf(card); if(di>=0) G.discard.splice(di,1);
    const tp=G.players[target];
    tp.intel.push(card);
    log(`【成仁取义】${tp.name} 被指定成功接收情报【${card.name}】。`);
    checkDeath(tp, p.id);
    render();
    if(!G.gameOver) checkGameEnd();
  }

  function canAnsha(killer){
    if(!hasSkill(killer,'暗杀') || killer.dead) return false;
    if(!killer.hand.some(c=>c.color==='gray')) return false;
    const canBurn = killer.intel.some(c=>c.color!=='gray');
    const canDiscard = killer.hand.length>=3;
    return canBurn || canDiscard;
  }
  async function effAnsha(killer){
    const canBurn = killer.intel.some(c=>c.color!=='gray');
    const canDiscard = killer.hand.length>=3;
    let cost;
    if(killer.isHuman){
      const opts=[];
      if(canBurn) opts.push({label:'烧毁自己一张非灰情报', value:'burn'});
      if(canDiscard) opts.push({label:'弃3张手牌', value:'discard'});
      opts.push({label:'取消', value:null});
      cost = await io.ask(killer.id, {kind:'dialog', title:'暗杀成本', html:'选择发动暗杀的成本：', options:opts}, null);
    } else {
      cost = canBurn ? 'burn' : 'discard';
    }
    if(cost===null || cost===undefined) return;

    let burnCard=null, discardCards=[], gray=null, target=null;
    if(killer.isHuman){
      if(cost==='burn'){
        burnCard = await showCardList(killer, killer.intel.filter(ic=>ic.color!=='gray'), '选择烧毁自己一张非灰情报');
        if(!burnCard) return;
        gray = await selectHandCard(killer, c=>c.color==='gray', true);
        if(!gray) return;
      } else {
        gray = await selectHandCard(killer, c=>c.color==='gray', true);
        if(!gray) return;
        const others = killer.hand.filter(c=>c!==gray);
        if(others.length<3){
          await io.ask(killer.id, {kind:'dialog', title:'暗杀成本',
            html:'弃3张手牌需除该灰色情报外仍有至少3张手牌，已取消暗杀。', options:[{label:'好', value:'ok'}]}, 'ok');
          return;
        }
        const chosenIds=new Set([gray.id]);
        for(let i=0;i<3;i++){
          const c = await selectHandCard(killer, cc=>!chosenIds.has(cc.id), true);
          if(!c) return;
          chosenIds.add(c.id);
          discardCards.push(c);
        }
      }
      target = await selectPlayer(killer, pp=>true, true);
      if(target===null) return;
    } else {
      if(cost==='burn'){
        burnCard = killer.intel.find(ic=>ic.color!=='gray');
        gray = killer.hand.find(c=>c.color==='gray');
      } else {
        gray = killer.hand.find(c=>c.color==='gray');
        const others = killer.hand.filter(c=>c!==gray);
        if(others.length<3) return;
        discardCards = others.slice(0,3);
      }
      target = await selectPlayer(killer, pp=>true, false);
      if(target===null) return;
    }
    if(!gray) return;

    if(cost==='burn'){
      removeIntel(killer, burnCard);
      log(`${killer.name} 烧毁自己一张非灰情报【${burnCard.name}】作为暗杀成本。`);
    } else {
      discardCards.forEach(c=>discardFromHand(killer,c));
      log(`${killer.name} 弃3张手牌作为暗杀成本。`);
    }
    discardFromHand(killer, gray);
    const tp=G.players[target];
    tp.intel.push(gray);
    log(`【暗杀】${killer.name} 将灰色情报【${gray.name}】令 ${tp.name} 成功接收！`);
    checkDeath(tp, killer.id);
    render();
    if(!G.gameOver) checkGameEnd();
  }

  async function assassinWindow(cur){
    const killer = G.players.find(k=>hasSkill(k,'暗杀') && !k.dead && k.id!==cur);
    if(!killer || !canAnsha(killer)) return;
    if(killer.isHuman){
      render();
      const doIt = await io.ask(killer.id, {kind:'assassin'}, false);
      render();
      if(doIt) await effAnsha(killer);
    } else {
      const target = G.players.find(pp=>!pp.dead && pp.id!==killer.id && grayIntelCount(pp)>=2);
      if(target && Math.random()<0.7) await effAnsha(killer);
    }
  }

  /* ================================================================
     回合循环
     ================================================================ */
  async function runTurn(p){
    if(p.dead) return;
    G.turnCount++;
    log(`<div style="border-top:1px dashed rgba(201,161,75,.4);margin-top:4px;padding-top:2px;">——— <b>${p.name} 的回合</b>（第${G.turnCount}回合）———</div>`);
    render();

    await assassinWindow(p);
    if(G.gameOver) return;

    await startTurnHooks(p);
    if(G.gameOver) return;

    await drawPhase(p);
    if(G.gameOver) return;
    render();

    await playPhase(p);
    if(G.gameOver) return;

    await intelPhase(p);
    if(G.gameOver) return;

    await endPhase(p);
    if(G.gameOver) return;

    G.players.forEach(pp=>{ pp.borrowed=null; pp.borrowFrom=null; pp.disabledSkill=null; });
  }

  async function gameLoop(){
    while(!G.gameOver){
      const p=G.players[G.current];
      await runTurn(p);
      if(G.gameOver) break;
      G.current = nextIdx(G.current);
      let guard=0;
      while(G.players[G.current].dead && guard<4){ G.current=nextIdx(G.current); guard++; }
      if(guard>=4) break;
      checkGameEnd();
    }
  }

  async function start(seats){
    await setupGame(seats);
    await announceIdentities();
    if(!G.gameOver) await gameLoop();
  }

  return {
    isOver(){ return !G || G.gameOver; },
    viewFor(id, full=false){ return G ? buildView(id, full) : null; },
    declare,
    start,
  };
}
