import { useEffect, useRef, useState } from 'react';
import { LocalSession, type LocalSnapshot } from './session/local';
import { NetworkSession, onlineApi, type NetworkSnapshot } from './session/network';
import type { RoomCommandInput, SeatAccess } from './session/protocol';
import type { PublicGameView } from './game/public';
import { OnlineHome, RoomBar, RoomLobby, RecoveryCard } from './ui/OnlineLobby';
import { RACERS, TRACKS } from './game/content';
import type { ActionInput } from './game/types';
import { AthleteArt, Die, Sparkle } from './ui/Artwork';
import { Board } from './ui/Board';
import { makePublicReplay } from './ui/replay';
import './ui/styles.css';

type Speed = 'normal' | 'fast' | 'off';
const phaseNames = { draft: '招募队伍', selection: '选择出场', reveal: '运动员亮相', race: '比赛进行中', raceEnd: '赛后结算', gameEnd: '冠军揭晓' };
const artIds = ['wizard', 'dragon', 'vampire'];

function RacerCard({ id, selected, disabled, onClick, index, draft = false }: { id: string; selected?: boolean; disabled?: boolean; onClick?: () => void; index?: number; draft?: boolean }) {
  const racer = RACERS[id];
  return <button className={`racer-card ${selected ? 'selected' : ''}`} disabled={disabled} onClick={onClick} data-testid={`${draft ? 'draft' : 'select'}-card-${id}`} aria-pressed={selected} style={{ '--racer-color': racer.color } as React.CSSProperties}>
    <div className="card-art"><AthleteArt id={id} color={racer.color}/><span className="card-mark">{selected ? '✓' : '✦'}</span>{selected && index !== undefined && index >= 0 && <span className="selection-order">第 {index + 1} 位</span>}</div>
    <div className="card-copy"><h3>{racer.name}</h3><p className="english">{racer.english}</p><p className="ability-text">{racer.description}</p></div>
  </button>;
}
function PlayerPanel({ game, online = false }: { game: PublicGameView; online?: boolean }) {
  const activePlayer = game.phase === 'race' ? game.pending?.playerId ?? game.racers.find(r=>r.id === game.turn?.actor)?.playerId : game.phase === 'draft' ? game.draftOrder[game.draftIndex] : game.phase === 'selection' && !online ? game.selectionPlayer : null;
  return <aside className="players-panel"><div className="panel-heading"><h2>选手席</h2><span>{game.players.length} 位玩家</span></div>{game.players.map(p=><div key={p.id} className={`player-row ${p.id === activePlayer ? 'is-current' : ''}`} style={{ '--player-color': p.color } as React.CSSProperties}>
    <div className="player-line"><span className="player-dot">{p.id + 1}</span><div><strong>{p.name}</strong><small>{online && game.phase === 'selection' ? game.lockedPlayerIds.includes(p.id) ? '出场阵容已锁定' : '正在秘密选择' : p.id === activePlayer ? '当前操作玩家' : `已招募 ${p.team.length} 名运动员`}</small></div><span className="score">{p.score}<small>分</small></span></div>
    <div className="team-chips">{p.team.map(id=><span key={id} className={p.used.includes(id) ? 'used' : ''} title={RACERS[id].description}>{RACERS[id].name}{p.used.includes(id) && ' ✓'}</span>)}</div>
    {(p.gold > 0 || p.silver > 0) && <div className="medals">金牌 {p.gold} · 银牌 {p.silver}</div>}
  </div>)}<div className="sidebar-note"><Sparkle/><p>骰子会决定距离，<br/>魔法会改变一切。</p></div></aside>;
}

export default function App() {
  const [local] = useState(() => new LocalSession());
  const [localState, setLocalState] = useState<LocalSnapshot>({ view: null, saved: null, loading: true, saveStatus: '', error: '' });
  const initialCode = new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '';
  const [mode, setMode] = useState<'local' | 'online'>(() => initialCode ? 'online' : 'local');
  const [network, setNetwork] = useState<NetworkSession | null>(null);
  const [online, setOnline] = useState<NetworkSnapshot>({ room: null, connection: 'connecting', pending: false, error: '' });
  const [access, setAccess] = useState<SeatAccess | null>(null);
  const [home, setHome] = useState(true);
  const [count, setCount] = useState(4);
  const [names, setNames] = useState(['玩家一','玩家二','玩家三','玩家四','玩家五','玩家六']);
  const [duo, setDuo] = useState(false);
  const [unlocked, setUnlocked] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<'characters' | 'rules' | 'log' | null>(null);
  const [query, setQuery] = useState('');
  const [speed, setSpeed] = useState<Speed>(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'normal');
  const [animating, setAnimating] = useState(false);
  const [replay, setReplay] = useState<PublicGameView[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const previous = useRef<PublicGameView | null>(null);
  const { saved, loading } = localState;
  const room = online.room;
  const view = mode === 'online' ? room?.game ?? null : localState.view;
  const me = room?.seats.find(seat => seat.id === room.viewerSeatId);
  const myId = me?.playerId ?? null;
  const isHost = room?.hostSeatId === room?.viewerSeatId;
  const saveStatus = mode === 'online' ? online.pending ? '正在确认操作…' : online.connection === 'connected' ? '服务端已保存' : '等待连接恢复' : localState.saveStatus;
  useEffect(() => { const unsubscribe = local.subscribe(setLocalState); void local.initialize(); return unsubscribe; }, [local]);
  useEffect(() => { if(localState.error) setError(localState.error); }, [localState.error]);
  useEffect(() => { if(!network) return; const unsubscribe = network.subscribe(setOnline); network.connect(); return () => { unsubscribe(); network.dispose(); }; }, [network]);
  useEffect(() => { if(online.error) setError(online.error); }, [online.error]);
  useEffect(() => {
    const prev = previous.current; previous.current = view;
    if(view && prev && view.id === prev.id && view.revision === prev.revision && view.phase !== 'selection') return;
    if(!view || !prev || view.id !== prev.id || view.revision < prev.revision || speed === 'off' || view.phase === 'selection') { setReplay([]); setAnimating(false); return; }
    // New snapshots replace an old animation backlog; animation never delays the server.
    const frames = makePublicReplay(prev, view).slice(-32); setReplay(frames); setAnimating(frames.length > 0);
  }, [view]);
  useEffect(() => { if(!replay.length) { setAnimating(false); return; } if(speed === 'off') { setReplay([]); setAnimating(false); return; } const timer = window.setTimeout(() => setReplay(frames => frames.slice(1)), speed === 'fast' ? 100 : 350); return () => window.clearTimeout(timer); }, [replay, speed]);
  useEffect(() => { setSelected([]); }, [view?.id, view?.race, view?.phase, mode === 'local' ? view?.selectionPlayer : null]);
  const canAct = (type: ActionInput['type']) => {
    if(!view || animating) return false;
    if(mode === 'local') return true;
    if(online.connection !== 'connected' || online.pending || myId === null || room?.status !== 'playing') return false;
    if(type === 'draft') return view.draftOrder[view.draftIndex] === myId;
    if(type === 'select') return !view.lockedPlayerIds.includes(myId);
    if(type === 'choose') return view.pending?.playerId === myId;
    if(type === 'roll' || type === 'continue') return view.racers.find(r => r.id === view.turn?.actor)?.playerId === myId;
    return !!isHost;
  };
  const act = async (action: ActionInput) => {
    if(!view || !canAct(action.type)) return;
    try {
      if(mode === 'online') await network!.execute({ type: 'game', gameId: view.id, revision: view.revision, race: view.race, action });
      else await local.execute(action);
      setError(''); if(action.type === 'select' || action.type === 'nextRace') { setUnlocked(null); setSelected([]); }
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const start = async () => {
    if(saved && !window.confirm('开始新游戏会覆盖当前自动存档。建议先导出备份，确定继续？')) return;
    try { await local.create({ names: names.slice(0,count).map((n,i) => n.trim() || `玩家 ${i+1}`), duo: count === 2 || (count === 3 && duo), seed: crypto.getRandomValues(new Uint32Array(1))[0] }); setReplay([]); setAnimating(false); setUnlocked(null); setSelected([]); setHome(false); setError(''); } catch(e) { setError(String(e)); }
  };
  const resume = async () => { await local.resume(); setReplay([]); setAnimating(false); setUnlocked(null); setSelected([]); setHome(false); setError(''); };
  const download = () => { const target = local.export(); if(!target) return; const blob = new Blob([target.json], {type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `魔法运动员-第${target.race+1}场-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const upload = async (file?: File) => { if(!file) return; try { if(saved && !window.confirm('导入将覆盖当前自动存档，确定继续？')) return; await local.import(await file.text()); setMode('local'); setReplay([]); setAnimating(false); setHome(false); setUnlocked(null); setSelected([]); setError(''); } catch(e) { setError(`无法导入存档：${e instanceof Error ? e.message : String(e)}`); } finally { if(importRef.current) importRef.current.value = ''; } };
  const enterRoom = (code: string, credentials?: SeatAccess) => { network?.dispose(); setOnline({room:null,connection:'connecting',pending:false,error:''}); setNetwork(new NetworkSession(code)); setAccess(credentials ?? null); setMode('online'); setHome(false); setError(''); setSelected([]); setReplay([]); previous.current = null; const url = new URL(location.href); url.searchParams.set('room', code); history.replaceState(null, '', url); };
  const leaveScreen = () => { network?.dispose(); setNetwork(null); setOnline({room:null,connection:'connecting',pending:false,error:''}); setHome(true); const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url); };
  const roomCommand = (action: RoomCommandInput) => { void network?.execute(action).catch(e => setError(e instanceof Error ? e.message : String(e))); };
  const regenerateRecovery = async () => { if(!room || !window.confirm('重新生成后，之前保存的恢复码将失效。确定继续？')) return; try { setAccess(await onlineApi.recovery(room.code)); } catch(e) { setError(String(e)); } };
  const boardView = replay[0] ?? view;
  const latestDie = (replay[0] ?? view)?.events.slice().reverse().find(e => e.type === 'die');
  const current = view?.turn ? view.racers.find(r => r.id === view.turn!.actor) : null;
  const currentDef = current ? RACERS[current.id] : null;
  const selectionOwner = view?.phase === 'selection' ? view.players.find(p => p.id === (mode === 'online' ? myId : view.selectionPlayer)) : null;
  const isCurtained = mode === 'local' && selectionOwner && unlocked !== selectionOwner.id;
  const locked = mode === 'online' && myId !== null && !!view?.lockedPlayerIds.includes(myId);
  const waitingId = view?.phase === 'race' ? view.pending?.playerId ?? current?.playerId : view?.phase === 'draft' ? view.draftOrder[view.draftIndex] : null;
  const waitingName = view?.players.find(p => p.id === waitingId)?.name;
  const totalRaces = 4;
  return <div className={`app speed-${speed}`}>
    <header className="site-header"><button className="brand" onClick={()=>mode === 'online' ? leaveScreen() : setHome(true)} aria-label="回到首页"><span className="brand-symbol"><Sparkle/></span><span>魔法运动员<small>MAGICAL ATHLETE</small></span></button><nav><button onClick={()=>setDrawer('characters')} className="nav-button">角色图鉴 <span>36</span></button><button onClick={()=>setDrawer('rules')} className="nav-button">玩法指南</button><span className="local-badge"><i/>{mode === 'online' ? '好友联机 · 各地同场' : '本地同机 · 离线可玩'}</span></nav></header>
    <input type="file" accept="application/json,.json" className="visually-hidden" ref={importRef} onChange={e=>void upload(e.target.files?.[0])} aria-label="导入 JSON 存档" data-testid="import-file"/>
    {error && <div className="error-banner" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误提示">×</button></div>}
    {!home && mode === 'online' && room && <RoomBar room={room} connection={online.connection} pending={online.pending} command={roomCommand} onRecovery={()=>void regenerateRecovery()} onExit={leaveScreen}/>}
    {home || (mode === 'local' && !view) ? <><div className="mode-switch" aria-label="游戏模式"><button className={mode === 'local' ? 'active' : ''} onClick={()=>{setMode('local');setError('');}}>本地同机</button><button className={mode === 'online' ? 'active' : ''} onClick={()=>{setMode('online');setError('');}} data-testid="online-mode">好友联机</button></div><main className="home-layout">
      <section className="hero"><div className="edition-label"><span/> 一场不太讲道理的魔法运动会</div><h1>各显神通，<br/>奔向<span>终点。</span><Sparkle className="hero-spark"/></h1><p className="hero-description">召集你的奇妙队伍。掷出命运的骰子。<br/>下一秒，赛场上的一切都可能改变。</p><div className="hero-badges"><span>2–6 位玩家</span><span>36 名运动员</span><span>4 场精彩比赛</span></div><div className="hero-illustration"><div className="hero-orbit"/><div className="hero-character c1"><AthleteArt id={artIds[0]} color="#ba9ddd"/><span>魔法已经就位</span></div><div className="hero-character c2"><AthleteArt id={artIds[1]} color="#eca86d"/></div><div className="hero-character c3"><AthleteArt id={artIds[2]} color="#7ebdb0"/></div><div className="hero-die"><Die value={5}/></div><span className="dashed-path">START ─ ─ ─ ─ ─ ─ ─ ─ →</span><Sparkle className="art-spark"/></div><p className="hero-footnote">原创数字棋盘 · 自动规则结算 · 随时保存继续</p></section>
      {mode === 'online' ? <OnlineHome onEnter={enterRoom} initialCode={initialCode} onError={setError}/> : <section className="setup-card"><div className="setup-heading"><span className="eyebrow">LET'S PLAY</span><h2>准备开赛</h2><p>把朋友叫到屏幕前，一起出发。</p></div><label className="field-label">参加人数 <span>共用一台电脑，轮流操作</span></label><div className="player-count">{[2,3,4,5,6].map(n=><button key={n} onClick={()=>setCount(n)} className={count===n?'active':''} aria-pressed={count===n}>{n}<small>人</small></button>)}</div><div className="name-inputs">{names.slice(0,count).map((name,i)=><label key={i}><span className={`name-dot color-${i}`}>{i+1}</span><input value={name} onChange={e=>setNames(names.map((n,j)=>j===i?e.target.value:n))} maxLength={16} aria-label={`玩家 ${i+1} 名称`}/></label>)}</div>{count===3&&<label className="duo-option"><input type="checkbox" checked={duo} onChange={e=>setDuo(e.target.checked)}/><span>双角色变体<small>每位玩家每场派出两名运动员</small></span></label>}{count===2&&<div className="mode-note">✦ 双人模式：每位玩家每场控制两名运动员。</div>}<button className="primary start-button" onClick={start} disabled={loading} data-testid="start-game">{loading?'正在读取存档…':'开启魔法运动会'}<span>↗</span></button>{saved&&<button className="resume-button" onClick={resume} data-testid="resume-game">继续上次游戏 <span>第 {saved.race+1} 场 · {phaseNames[saved.phase]} →</span></button>}<div className="setup-footer"><button onClick={()=>importRef.current?.click()}>导入存档</button>{saved&&<button onClick={download}>导出已有存档</button>}<span>自动保存到此浏览器</span></div></section>}
    </main></> : mode === 'online' && (!view || room?.status === 'closed') ? <main className="online-room-layout">{room ? <RoomLobby room={room} disabled={online.connection !== 'connected' || online.pending} command={roomCommand}/> : <section className="room-lobby"><h2>{online.connection === 'revoked' ? '无法进入此房间' : '正在连接房间…'}</h2><p>{online.error || '请稍候，正在恢复你的座位。'}</p><button className="secondary" onClick={leaveScreen}>返回好友联机</button></section>}</main> : view && <main className="game-layout" data-testid="game" data-phase={view.phase} data-revision={view.revision} data-animating={animating}>
      <div className="match-bar"><div><span className="eyebrow">MAGICAL CHAMPIONSHIP</span><h1>{phaseNames[view.phase]}</h1></div><div className="race-progress">{Array.from({length:totalRaces},(_,i)=><div key={i} className={`${i===view.race?'active':''} ${i<view.race?'complete':''}`}><span>{i<view.race?'✓':`0${i+1}`}</span><small>{i%2===0?'温和':'狂野'}</small></div>)}</div><div className="game-tools"><span className={saveStatus.includes('失败')?'save-status failed':'save-status'}>{saveStatus || '存档已恢复'}</span><div>{mode === 'local' && <><button onClick={download} title="导出存档">导出</button><button onClick={()=>importRef.current?.click()}>导入</button></>}<button onClick={()=>mode === 'online' ? leaveScreen() : setHome(true)}>首页</button></div></div></div>
      {mode === 'online' && <div className="online-turn-notice" role="status">{online.connection !== 'connected' ? '连接恢复前暂不能操作。对局保存在服务器。' : view.phase === 'selection' ? '各自在自己的屏幕上选择，全部锁定后统一揭示。' : ['reveal','raceEnd'].includes(view.phase) ? `等待房主 ${room?.seats.find(s=>s.id===room.hostSeatId)?.name} 继续` : waitingName ? `${waitingId === myId ? '轮到你操作' : `等待 ${waitingName} 操作`}${room?.seats.find(s=>s.playerId===waitingId)?.online === false ? ' · 对方离线，等待重连' : ''}` : '比赛已完成'}</div>}
      <div className="game-columns"><div className="game-main">
      {view.phase === 'draft' && <section className="draft-panel"><div className="section-intro"><span className="round-stamp">P{(view.draftOrder[view.draftIndex]??0)+1}</span><div><h2>{view.players[view.draftOrder[view.draftIndex]]?.name}，招募你的运动员</h2><p>选择一位加入队伍。观察技能，为四场比赛做好准备。</p></div><span className="counter">{view.draftIndex+1} / {view.draftOrder.length}</span></div><div className="racer-grid">{view.market.map(id=><RacerCard key={id} id={id} draft disabled={!canAct('draft')} onClick={()=>act({type:'draft',racerId:id})}/>)}</div></section>}
      {view.phase === 'selection' && <section className="selection-panel">
        {locked ? <div className="privacy-curtain" data-testid="selection-locked"><span className="eyebrow">LINEUP LOCKED</span><h2>出场阵容已锁定</h2><p>{(view.selections[myId!] ?? []).map(id=>RACERS[id].name).join(' → ')}</p><p>等待其他玩家完成选择，随后一起揭晓。</p><div className="locked-players">{view.players.map(p=><span key={p.id}>{p.name} {view.lockedPlayerIds.includes(p.id)?'已锁定 ✓':'选择中…'}</span>)}</div></div> : isCurtained ? <div className="privacy-curtain" data-testid="handoff"><div className="privacy-symbol"><Sparkle/></div><span className="eyebrow">SECRET TEAM SELECTION</span><h2>请把屏幕交给<br/><em>{selectionOwner?.name}</em></h2><p>其他玩家暂时移开视线。<br/>选择完成后，屏幕会再次遮挡。</p><button className="primary" onClick={()=>{setUnlocked(selectionOwner!.id);local.setViewer(selectionOwner!.id);}} data-testid="handoff-continue">我是 {selectionOwner?.name}，查看队伍 →</button></div> : <><div className="section-intro"><span className="round-stamp">P{selectionOwner!.id+1}</span><div><h2>{selectionOwner!.name}，秘密选择出场角色</h2><p>{view.duo?'依次选择两位；点击顺序就是本场行动顺序。':'选择一位运动员代表队伍出战。'}</p></div></div><div className="racer-grid">{selectionOwner!.team.filter(id=>!selectionOwner!.used.includes(id)).map(id=><RacerCard key={id} id={id} selected={selected.includes(id)} index={selected.indexOf(id)} onClick={()=>setSelected(selected.includes(id)?selected.filter(x=>x!==id):selected.length<(view.duo?2:1)?[...selected,id]:view.duo?selected:[id])}/>)}</div><div className="selection-footer"><span>已选择 {selected.length} / {view.duo?2:1}{view.duo&&selected.length>0&&` · ${selected.map(id=>RACERS[id].name).join(' → ')}`}</span><button className="primary" disabled={selected.length!==(view.duo?2:1) || !canAct('select')} onClick={()=>act({type:'select',playerId:selectionOwner!.id,racerIds:selected})} data-testid="confirm-selection">{mode === 'online' ? '锁定我的出场阵容 →' : '确认出场并遮挡 →'}</button></div></>}
      </section>}
      {view.phase === 'reveal' && <section className="reveal-panel"><div className="center-intro"><span className="eyebrow">MEET YOUR ATHLETES</span><h2>本场运动员，闪亮登场！</h2><p>第 {view.race+1} 场 · {TRACKS[view.track].name} · 所有人已完成选择</p></div><div className="reveal-grid">{view.players.map(p=><div className="reveal-team" key={p.id}><span className="team-label" style={{color:p.color}}>{p.name}</span>{(view.selections[p.id]??[]).map((id,i)=><div className="revealed-racer" key={id}><AthleteArt id={id} color={RACERS[id].color}/><h3>{RACERS[id].name}</h3><p>{RACERS[id].description}</p>{view.duo&&<span className="order-label">行动顺序 {i+1}</span>}</div>)}</div>)}</div><button className="primary" disabled={!canAct('reveal')} onClick={()=>act({type:'reveal'})} data-testid="reveal-race">全员就位，开始比赛 →</button></section>}
      {(view.phase === 'race' || view.phase === 'raceEnd' || view.phase === 'gameEnd') && <Board game={boardView!} speed={speed}/>}
      {view.phase === 'race' && <section className="turn-panel" aria-live="polite">
        {view.paused ? <><div><h2>连锁效果暂停</h2><p>已保存当前结算状态，继续处理余下效果。</p></div><button className="primary" disabled={!canAct('continue')} onClick={()=>act({type:'continue'})}>继续结算 →</button></> : view.pending ? <div className="decision-panel" data-testid="decision"><span className="decision-owner">请 {view.players[view.pending.playerId]?.name} 操作 · {RACERS[view.pending.actor]?.name}</span><h2>{view.pending.title}</h2><p>{view.pending.description}</p><div className="decision-options">{view.pending.options.map(option=><button key={option.id} className="option-button" disabled={!canAct('choose')} onClick={()=>act({type:'choose',decisionId:view.pending!.id,optionId:option.id})} data-testid={`choice-${option.id}`}>{option.label}</button>)}</div></div> : <><div className="current-athlete">{currentDef&&<AthleteArt id={current!.id} color={currentDef.color} small/>}<div><span className="eyebrow">{current ? view.players[current.playerId]?.name : '准备比赛'} · 第 {view.turn?.number??1} 回合</span><h2>{currentDef?.name ?? '等待结算'}{current?.power&&current.power!==current.id&&<small className="copied-power">复制：{RACERS[current.power].name}</small>}</h2><p>{(current?.power ? RACERS[current.power]?.description : currentDef?.description)}</p></div></div><div className="roll-area"><div className="die-result"><Die value={latestDie?.value??view.turn?.rolled??null} rolling={animating}/><small>{latestDie?.message??'等待掷骰'}</small></div><button className="primary" disabled={!canAct('roll') || view.turn?.stage !== 'ready'} onClick={()=>act({type:'roll'})} data-testid="roll">{animating?'魔法结算中…':view.turn?.stage==='ready'?'开始回合 →':'正在结算…'}</button></div></>}
      </section>}
      {!animating && (view.phase === 'raceEnd' || view.phase === 'gameEnd') && <section className="results-panel" data-testid={view.phase==='gameEnd'?'game-over':'race-results'}><div className="center-intro"><span className="eyebrow">{view.phase==='gameEnd'?'THE GRAND FINALE':'RACE COMPLETE'}</span><h2>{view.phase==='gameEnd'?'魔法运动会圆满落幕！':`第 ${view.race+1} 场 · 赛后领奖台`}</h2><p>{view.phase==='gameEnd'?'四场冒险，每一分都值得喝彩。':'积分已经加入总榜，下一场又是全新的冒险。'}</p></div>{view.phase==='raceEnd'?<div className="result-list">{view.results.at(-1)?.standings.map(r=><div key={`${r.racerId}-${r.place}`}><span className="place">{r.place}</span><AthleteArt id={r.racerId} color={RACERS[r.racerId].color} small/><strong>{RACERS[r.racerId].name}<small>{view.players[r.playerId]?.name}</small></strong><b>+{r.points}<small> 分</small></b></div>)}</div>:<div className="final-ranking">{[...view.players].sort((a,b)=>b.score-a.score).map((p,i)=><div key={p.id} className={p.score===Math.max(...view.players.map(x=>x.score))?'winner':''}><span className="place">{p.score===Math.max(...view.players.map(x=>x.score))?'★':i+1}</span><strong>{p.name}<small>金牌 {p.gold} · 银牌 {p.silver}</small></strong><b>{p.score}<small> 分</small></b></div>)}</div>}{view.phase==='raceEnd'?<button className="primary" disabled={!canAct('nextRace')} onClick={()=>act({type:'nextRace'})} data-testid="next-race">{view.race>=3?'查看最终排名':'准备下一场'} →</button>:<div className="end-buttons"><button className="primary" onClick={()=>mode === 'online' ? leaveScreen() : setHome(true)}>返回首页</button>{mode === 'local' && <button className="secondary" onClick={download}>保存比赛记录</button>}</div>}</section>}
      <div className="game-bottom"><button onClick={()=>setDrawer('log')}>☷ 查看结算记录 <span>{view.events.length}</span></button><label>动画速度 <select value={speed} onChange={e=>setSpeed(e.target.value as Speed)} aria-label="动画速度"><option value="normal">正常</option><option value="fast">快速</option><option value="off">关闭</option></select></label></div>{view.events.length>0&&<div className="latest-event" role="status"><span>最新动态</span>{(replay[0]??view).events.at(-1)?.message}</div>}
      </div><PlayerPanel game={view} online={mode === 'online'}/></div>
    </main>}
    <footer className="site-footer"><span>MAGICAL ATHLETE <i>✦</i> 把不可能，变成下一步。</span><span>{mode === 'online' ? '好友联机 · 服务端规则结算' : '本地版 · 规则自动结算'}</span></footer>
    {drawer&&<div className="drawer-overlay" onClick={()=>setDrawer(null)}><section className={`drawer ${drawer==='characters'?'wide':''}`} role="dialog" aria-modal="true" aria-label={drawer==='characters'?'角色图鉴':drawer==='log'?'结算记录':'玩法指南'} onClick={e=>e.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">MAGICAL ATHLETE</span><h2>{drawer==='characters'?'认识 36 位奇妙运动员':drawer==='log'?'每一步，都有迹可循':'欢迎来到魔法运动会'}</h2></div><button className="close-button" onClick={()=>setDrawer(null)} aria-label="关闭面板">×</button></div>{drawer==='characters'?<><input className="character-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索角色名称或技能…" aria-label="搜索角色"/><div className="racer-grid gallery">{Object.entries(RACERS).filter(([,r])=>(r.name+r.english+r.description).toLowerCase().includes(query.toLowerCase())).map(([id])=><RacerCard key={id} id={id}/>)}</div></>:drawer==='log'?<ol className="event-log">{view?.events.slice().reverse().map(event=><li key={event.id}><span>#{event.id} · 第 {event.race+1} 场</span><p>{event.message}</p></li>)}{!view?.events.length&&<p>游戏开始后，这里会记录每一次魔法。</p>}</ol>:<div className="rules-content"><p className="rules-lead">这是一场关于速度、运气，以及一点点魔法的比赛。</p>{[['01','召集队伍','所有玩家轮流从公开角色中招募运动员。仔细阅读技能，组合属于你的队伍。'],['02','秘密派出选手','每场比赛开始前，私密选择尚未出场的角色；同机轮流交接，联机各自同时选择。双角色模式按选择顺序行动。全部确认后，一起揭晓。'],['03','掷骰，发动魔法','点击「开始回合」，系统处理回合能力、掷骰和移动。遇到需要你决定的能力，选择操作即可。其余效果自动结算。'],['04','比赛四场，争取总冠军','根据单场名次和奖励获得积分。四场依次使用温和、狂野、温和、狂野赛道。四场结束后比较总分；最高分相同则共享胜利。']].map(([num,title,body])=><article key={num}><span>{num}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}<div className="rules-tip"><strong>放心中途离开</strong><p>每次有效操作后都会自动保存。本地模式可导出 JSON 备份；联机模式保存在服务器，原浏览器可自动恢复，换设备需个人恢复码。联机房间从最后一次有效活动起保留 7 天。</p></div><p className="rules-source">基于 CMYK 基础盒与官方修订。中文名称为本项目译名，角色图案为原创插画。详细规则核对与覆盖情况见项目文档。</p></div>}</section></div>}
    {access && <RecoveryCard access={access} onClose={()=>setAccess(null)}/>}
  </div>;
}
