import { RACERS, RULES_VERSION } from '../game/content';
import type { GameState } from '../game/types';

const DB_NAME = 'magical-athlete';
const STORE_NAME = 'games';
const ACTIVE_KEY = 'active';
const MAX_BYTES = 5 * 1024 * 1024;
const ROLE_IDS = new Set(Object.keys(RACERS));
// Keep this list synchronized with the rule engine. Never execute an imported arbitrary task.
const TASK_KINDS = new Set([
  'preRace', 'copyCheck', 'startTurn', 'startPower', 'main', 'rollDie', 'reroll', 'resolveRoll', 'rollReaction', 'mainPower', 'modifiers', 'performMain', 'trip', 'endTurn', 'advance', 'move', 'commitMove', 'space', 'reaction', 'notify', 'finish', 'duelWindow', 'ready',
  'babyBanana', 'bonusMove', 'duels', 'chooseGuess', 'chooseCopy', 'chooseEgg', 'chooseTwin', 'chooseStart', 'chooseMain', 'chooseReroll', 'choosePower', 'chooseFollow', 'chooseDuel', 'choosePrediction',
]);
const DECISION_KINDS = new Set(['chooseGuess', 'chooseCopy', 'chooseEgg', 'chooseTwin', 'chooseStart', 'chooseMain', 'chooseReroll', 'choosePower', 'chooseFollow', 'chooseDuel', 'choosePrediction']);
const NO_ACTOR_KINDS = new Set(['copyCheck', 'ready', 'duels', 'move', 'commitMove']);
type RecordValue = Record<string, unknown>;
function fail(path: string): never { throw new Error(`存档损坏或不兼容：${path}`); }
function object(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path);
  for (const key of Object.keys(value)) if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(path);
  return value as RecordValue;
}
function keys(value: RecordValue, names: string, path: string): void {
  const allowed = new Set(names.split(' '));
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`);
}
function array(value: unknown, path: string, max = 1000): unknown[] { if (!Array.isArray(value) || value.length > max) fail(path); return value; }
function string(value: unknown, path: string, max = 500, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.length)) fail(path); return value;
}
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(path); return value; }
function boolean(value: unknown, path: string): void { if (typeof value !== 'boolean') fail(path); }
function member(value: unknown, values: readonly unknown[], path: string): void { if (!values.includes(value)) fail(path); }
function role(value: unknown, path: string): string { const id = string(value, path, 80); if (!ROLE_IDS.has(id)) fail(path); return id; }
function roleList(value: unknown, path: string, unique = true): string[] {
  const ids = array(value, path, 36).map((entry, index) => role(entry, `${path}[${index}]`));
  if (unique && new Set(ids).size !== ids.length) fail(`${path} 含重复角色`); return ids;
}
function textList(value: unknown, path: string, max: number): string[] { return array(value, path, max).map(entry => string(entry, path, 20000)); }

/** Validate serialized data before it can be used by the rules engine or replace a save. */
export function validateGameState(value: unknown): GameState {
  const s = object(value, 'state');
  keys(s, 'schemaVersion rulesVersion id revision rng phase players duo race track deck market draftOrder draftIndex draftBatch firstPlayer selectionPlayer selections racers turnOrder turn queue pending events results raceStartScores finishOrder processedActions chainSeen paused', 'state');
  member(s.schemaVersion, [1], 'schemaVersion');
  member(s.rulesVersion, [RULES_VERSION], 'rulesVersion');
  string(s.id, 'id', 200); integer(s.revision, 'revision'); integer(s.rng, 'rng', 0, 0xffffffff);
  member(s.phase, ['draft', 'selection', 'reveal', 'race', 'raceEnd', 'gameEnd'], 'phase');
  boolean(s.duo, 'duo'); boolean(s.paused, 'paused'); integer(s.race, 'race', 0, 3); member(s.track, ['mild', 'wild'], 'track');
  const players = array(s.players, 'players', 6).map((value, index) => {
    const p = object(value, `players[${index}]`);
    keys(p, 'id name color team used score gold silver', 'player');
    integer(p.id, 'player.id', 0, 5); string(p.name, 'player.name', 80); string(p.color, 'player.color', 100);
    const team = roleList(p.team, 'player.team'); const used = roleList(p.used, 'player.used');
    if (used.some(id => !team.includes(id))) fail('player.used 不属于队伍');
    for (const field of ['score', 'gold', 'silver']) integer(p[field], `player.${field}`, 0, 10000);
    return p;
  });
  if (players.length < 2 || players.some((p, index) => p.id !== index)) fail('players.id');
  if (players.length === 2 && !s.duo) fail('2 人对局必须启用双角色');
  if (s.duo && players.length > 3) fail('双角色人数');
  const pid = (v: unknown, path: string): number => integer(v, path, 0, players.length - 1);
  pid(s.firstPlayer, 'firstPlayer'); pid(s.selectionPlayer, 'selectionPlayer');
  const deck = roleList(s.deck, 'deck'); const market = roleList(s.market, 'market');
  const owned = players.flatMap(player => player.team as string[]);
  const allocated = [...deck, ...market, ...owned];
  if (new Set(allocated).size !== allocated.length) fail('牌库、招募区或队伍存在重复角色');
  const order = array(s.draftOrder, 'draftOrder', 100); order.forEach(v => pid(v, 'draftOrder'));
  integer(s.draftIndex, 'draftIndex', 0, order.length); integer(s.draftBatch, 'draftBatch', 0, 4);
  if (s.phase === 'draft' && ((s.draftIndex as number) >= order.length || !market.length)) fail('draft 无法继续招募');
  const selections = object(s.selections, 'selections');
  for (const [key, values] of Object.entries(selections)) {
    if (!/^\d+$/.test(key)) fail('selections.playerId');
    const player = players[pid(Number(key), 'selections.playerId')];
    const ids = roleList(values, 'selections');
    if (ids.length !== (s.duo ? 2 : 1) || ids.some(id => !(player.team as string[]).includes(id))) fail('selections 角色不属于玩家队伍');
  }
  const racers = array(s.racers, 'racers', 6).map(v => {
    const r = object(v, 'racer'); keys(r, 'id playerId position tripped finished eliminated power prediction eggBonus copyTarget firstTurnTaken mimic copyLeaders', 'racer');
    role(r.id, 'racer.id'); pid(r.playerId, 'racer.playerId');
    if (!(players[r.playerId as number].team as string[]).includes(r.id as string)) fail('racer 不属于玩家队伍');
    integer(r.position, 'racer.position', 0, 10000);
    boolean(r.tripped, 'racer.tripped'); boolean(r.eliminated, 'racer.eliminated'); boolean(r.eggBonus, 'racer.eggBonus');
    if (r.finished !== null) integer(r.finished, 'racer.finished', 1, 6);
    if (r.power !== null) role(r.power, 'racer.power');
    if (r.prediction !== undefined) role(r.prediction, 'racer.prediction');
    if (r.copyLeaders !== undefined) { const ids=string(r.copyLeaders,'racer.copyLeaders',1000).split(','); ids.forEach(id=>role(id,'racer.copyLeaders')); }
    if (r.copyTarget !== undefined) role(r.copyTarget, 'racer.copyTarget');
    if (r.firstTurnTaken !== undefined) boolean(r.firstTurnTaken, 'racer.firstTurnTaken');
    if (r.mimic !== undefined) boolean(r.mimic, 'racer.mimic');
    return r;
  });
  const racerIds = new Set(racers.map(r => r.id));
  if (racerIds.size !== racers.length) fail('racers 含重复角色');
  const racer = (v: unknown, path: string): string => { const id = role(v, path); if (!racerIds.has(id)) fail(`${path} 引用了未出场角色`); return id; };
  const racersList = (v: unknown, path: string) => { const ids = roleList(v, path); ids.forEach(id => racer(id, path)); return ids; };
  for (const r of racers) if (r.prediction !== undefined) racer(r.prediction, 'prediction');
  const turnOrder = racersList(s.turnOrder, 'turnOrder'); roleList(s.finishOrder, 'finishOrder', false).forEach(id => racer(id, 'finishOrder'));
  if (racers.length && turnOrder.length !== racers.length) fail('turnOrder');
  const validateTask = (value: unknown, path: string, decision = false): RecordValue => {
    const t = object(value, path); keys(t, 'kind actor target ids amount value index text power moves trigger flags', path);
    const kind = string(t.kind, `${path}.kind`, 80);
    if (!TASK_KINDS.has(kind) || DECISION_KINDS.has(kind) !== decision) fail(`${path}.kind`);
    if (!NO_ACTOR_KINDS.has(kind)) racer(t.actor, `${path}.actor`);
    if (kind === 'babyBanana') racer(t.target, `${path}.target`);
    if (kind === 'rollReaction') { racer(t.target, `${path}.target`); integer(t.value, `${path}.value`, 1, 6); }
    if (kind === 'space') integer(t.value, `${path}.value`, 0, 30);
    if (['move', 'commitMove', 'chooseFollow'].includes(kind)) array(t.moves, `${path}.moves`, 36);
    if (kind === 'reaction') object(t.trigger, `${path}.trigger`);
    if (kind === 'chooseStart') member(t.power, ['cheerleader', 'hypnotist', 'third_wheel'], `${path}.power`);
    if (kind === 'chooseMain') member(t.power, ['legs', 'flip_flop'], `${path}.power`);
    if (kind === 'choosePower') member(t.power, ['alchemist', 'rocket_scientist'], `${path}.power`);
    for (const field of ['actor', 'target']) if (t[field] !== undefined) racer(t[field], `${path}.${field}`);
    if (t.ids !== undefined) racersList(t.ids, `${path}.ids`);
    for (const field of ['amount', 'value', 'index']) if (t[field] !== undefined) integer(t[field], `${path}.${field}`, -10000, 10000);
    if (t.text !== undefined) string(t.text, `${path}.text`, 2000, true);
    if (t.power !== undefined) role(t.power, `${path}.power`);
    if (t.flags !== undefined) roleList(t.flags, `${path}.flags`, false);
    if (t.moves !== undefined) array(t.moves, `${path}.moves`, 36).forEach(v => {
      const m = object(v, 'move'); keys(m, 'id amount teleport destination ignoreExact follow', 'move'); racer(m.id, 'move.id'); integer(m.amount, 'move.amount', -10000, 10000);
      if (m.follow !== undefined) {
        racer(m.follow, 'move.follow');
        const moves = t.moves as RecordValue[];
        const leader = moves.find(x => x.id === m.follow);
        if (!leader || (leader.follow !== undefined && moves.indexOf(leader) >= moves.indexOf(m)) || m.follow === m.id || m.teleport) fail('move.follow');
      }
      if (m.teleport) integer(m.destination, 'move.destination', 0, 30);
      if (m.destination !== undefined) integer(m.destination, 'move.destination', 0, 10000);
      for (const field of ['teleport', 'ignoreExact']) if (m[field] !== undefined) boolean(m[field], `move.${field}`);
    });
    if (t.trigger !== undefined) {
      const tr = object(t.trigger, 'trigger'); keys(tr, 'kind actor before after moved teleported value source bonus', 'trigger');
      member(tr.kind, ['movement'], 'trigger.kind'); racer(tr.actor, 'trigger.actor');
      object(tr.before, 'trigger.before'); object(tr.after, 'trigger.after');
      const moved = racersList(tr.moved, 'trigger.moved');
      if (!moved.length) fail('trigger.moved');
      const before = tr.before as RecordValue, after = tr.after as RecordValue;
      if (Object.keys(before).some(id => !(id in after)) || Object.keys(after).some(id => !(id in before)) || moved.some(id => !(id in before))) fail('trigger 位置快照不完整');
      for (const field of ['before', 'after']) if (tr[field] !== undefined) {
        const positions = object(tr[field], `trigger.${field}`);
        Object.entries(positions).forEach(([id, position]) => { racer(id, 'trigger.position.id'); integer(position, 'trigger.position', 0, 10000); });
      }
      for (const field of ['moved', 'teleported']) if (tr[field] !== undefined) racersList(tr[field], `trigger.${field}`);
      if (tr.value !== undefined) integer(tr.value, 'trigger.value', -10000, 10000);
      if (tr.source !== undefined) string(tr.source, 'trigger.source', 100);
      if (tr.bonus !== undefined) boolean(tr.bonus, 'trigger.bonus');
    }
    return t;
  };
  array(s.queue, 'queue', 10000).forEach(t => validateTask(t, 'queue.task'));
  if (s.turn !== null) {
    const t = object(s.turn, 'turn'); keys(t, 'actor number stage rolled startPosition rollCount usedMerchants modifiers base double skip guess extra nextOverride', 'turn');
    racer(t.actor, 'turn.actor'); integer(t.number, 'turn.number'); member(t.stage, ['ready', 'resolving'], 'turn.stage');
    if (t.rolled !== null) integer(t.rolled, 'turn.rolled', 1, 6);
    integer(t.startPosition, 'turn.startPosition', 0, 10000); integer(t.rollCount, 'turn.rollCount'); racersList(t.usedMerchants, 'turn.usedMerchants');
    integer(t.modifiers, 'turn.modifiers', -10000, 10000);
    if (t.base !== undefined) integer(t.base, 'turn.base', -10000, 10000);
    if (t.guess !== undefined) integer(t.guess, 'turn.guess', 1, 6);
    for (const field of ['double', 'skip', 'extra']) if (t[field] !== undefined) boolean(t[field], `turn.${field}`);
    racersList(t.nextOverride, 'turn.nextOverride');
  }
  if (s.pending !== null) {
    const d = object(s.pending, 'pending'); keys(d, 'id playerId actor title description options task', 'pending');
    string(d.id, 'pending.id', 200); pid(d.playerId, 'pending.playerId'); racer(d.actor, 'pending.actor');
    string(d.title, 'pending.title', 500); string(d.description, 'pending.description', 4000, true);
    const options = array(d.options, 'pending.options', 100);
    if (!options.length) fail('pending.options');
    const ids = options.map(v => { const o = object(v, 'option'); keys(o, 'id label', 'option'); string(o.label, 'option.label', 1000); return string(o.id, 'option.id', 200); });
    if (new Set(ids).size !== ids.length) fail('pending.options.id');
    const task = validateTask(d.task, 'pending.task', true);
    if (task.actor !== d.actor || racers.find(r => r.id === d.actor)?.playerId !== d.playerId) fail('pending 操作玩家或角色不匹配');
    const actor = racers.find(r => r.id === d.actor)!;
    const live = racers.filter(r => !r.eliminated && r.finished === null);
    const turn = object(s.turn, 'pending.turn');
    for (const option of ids) {
      let allowed = false;
      switch (task.kind) {
        case 'chooseCopy': {
          const lead = Math.max(...live.map(r => r.position as number));
          allowed = live.some(r => r.id === option && r.id !== actor.id && r.position === lead); break;
        }
        case 'chooseEgg': allowed = ROLE_IDS.has(option); break;
        case 'chooseTwin': allowed = option === 'skip' || array(s.results, 'results', 4).some(v => array(object(v, 'result').standings, 'standings', 6).some(v => { const row = object(v, 'standing'); return row.place === 1 && row.racerId === option; })); break;
        case 'choosePrediction': allowed = live.some(r => r.id === option); break;
        case 'chooseGuess': allowed = ['skip','1','2','3','4','5','6'].includes(option); break;
        case 'choosePower': allowed = ['yes','skip'].includes(option); break;
        case 'chooseStart':
          allowed = option === 'skip' || (task.power === 'cheerleader' ? option === 'yes' : task.power === 'hypnotist' ? live.some(r => r.id === option && r.id !== actor.id) : /^(0|[1-9]\d*)$/.test(option) && Number(option) !== actor.position && live.filter(r => r.position === Number(option)).length === 2); break;
        case 'chooseMain': allowed = option === 'skip' || (task.power === 'legs' ? option === 'yes' : live.some(r => r.id === option && r.id !== actor.id)); break;
        case 'chooseReroll':
          allowed = option === 'keep' || (option === 'magic' ? actor.power === 'magician' && (turn.rollCount as number) < 2 : live.some(r => r.id === option && r.power === 'dicemonger' && !(turn.usedMerchants as string[]).includes(option))); break;
        case 'chooseFollow': allowed = option === 'skip' || (task.moves as RecordValue[]).some(m => m.id === option && m.id !== actor.id && !m.teleport && m.amount !== 0 && racers.find(r => r.id === m.id)?.position === actor.position); break;
        case 'chooseDuel': allowed = option === 'skip' || live.some(r => r.id === option && r.id !== actor.id && r.position === actor.position); break;
      }
      if (!allowed) fail(`pending.options 非法选项 ${option}`);
    }
  }
  if (['race', 'raceEnd', 'gameEnd'].includes(s.phase as string) && racers.length !== players.length * (s.duo ? 2 : 1)) fail('缺少出场角色');
  if (s.phase === 'race' && !s.turn) fail('race 缺少当前回合');
  if (['raceEnd', 'gameEnd'].includes(s.phase as string) && !(s.finishOrder as string[]).length) fail('已结束比赛缺少名次');
  if (['reveal', 'race', 'raceEnd', 'gameEnd'].includes(s.phase as string) && Object.keys(selections).length !== players.length) fail('出场选择不完整');
  if (s.phase === 'race') {
    const turn = s.turn as RecordValue;
    if (s.pending === null && !s.paused && turn.stage !== 'ready') fail('race 没有可继续的操作');
    if (s.paused && !(s.queue as unknown[]).length) fail('暂停状态缺少待处理结算');
  }
  if (s.phase !== 'race' && (s.pending !== null || (s.queue as unknown[]).length || s.paused)) fail('非比赛阶段含待决结算');
  array(s.events, 'events', 30000).forEach(v => {
    const e = object(v, 'event'); keys(e, 'id type message racerId from to value race', 'event');
    integer(e.id, 'event.id'); string(e.type, 'event.type', 80); string(e.message, 'event.message', 4000, true); integer(e.race, 'event.race', 0, 3);
    if (e.racerId !== undefined) role(e.racerId, 'event.racerId');
    for (const field of ['from', 'to', 'value']) if (e[field] !== undefined) integer(e[field], `event.${field}`, -10000, 10000);
  });
  const scores = (v: unknown, path: string) => { const values = array(v, path, 6); if (values.length !== players.length) fail(path); values.forEach(n => integer(n, path, 0, 10000)); };
  scores(s.raceStartScores, 'raceStartScores');
  array(s.results, 'results', 4).forEach(v => {
    const r = object(v, 'result'); keys(r, 'race track standings scores', 'result'); integer(r.race, 'result.race', 0, 3); member(r.track, ['mild', 'wild'], 'result.track'); scores(r.scores, 'result.scores');
    array(r.standings, 'result.standings', 6).forEach(v => {
      const row = object(v, 'standing'); keys(row, 'racerId playerId place points', 'standing'); role(row.racerId, 'standing.racerId'); pid(row.playerId, 'standing.playerId'); integer(row.place, 'standing.place', 1, 6); integer(row.points, 'standing.points', 0, 10000);
    });
  });
  textList(s.processedActions, 'processedActions', 30000); textList(s.chainSeen, 'chainSeen', 30000);
  return structuredClone(value) as GameState;
}

export function exportGame(state: GameState): string {
  const json = JSON.stringify({ schemaVersion: 1, rulesVersion: RULES_VERSION, state: validateGameState(state) }, null, 2);
  if (new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('存档超过 5 MB 大小限制');
  return json;
}
export function importGame(text: string): GameState {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('存档超过 5 MB 大小限制');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('无法读取存档：JSON 格式错误'); }
  const envelope = object(parsed, '存档'); keys(envelope, 'schemaVersion rulesVersion state', '存档');
  member(envelope.schemaVersion, [1], '存档格式版本'); member(envelope.rulesVersion, [RULES_VERSION], '存档规则版本');
  return validateGameState(envelope.state);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('当前浏览器不支持 IndexedDB，无法保存对局')); return; }
    let blocked = false;
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME); };
    request.onerror = () => reject(new Error(`无法打开存档：${request.error?.message ?? '未知错误'}`));
    request.onblocked = () => { blocked = true; reject(new Error('存档数据库被其他页面占用，请关闭其他游戏页面后重试')); };
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let request: IDBRequest<T>;
    try { tx = db.transaction(STORE_NAME, mode); request = operation(tx.objectStore(STORE_NAME)); }
    catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error(`存档操作失败：${tx.error?.message ?? request.error?.message ?? '事务取消'}`)); };
  });
}
// One queue orders reads, writes and clears. A failed operation rejects its caller but
// does not permanently poison subsequent saves. Capture snapshots before enqueueing.
let operations: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.catch(() => undefined);
  return result;
}
export function saveGame(state: GameState): Promise<void> {
  let snapshot: string;
  try { snapshot = exportGame(state); } catch (error) { return Promise.reject(error); }
  return enqueue(async () => { await transaction('readwrite', store => store.put(snapshot, ACTIVE_KEY)); });
}
export function loadGame(): Promise<GameState | null> {
  return enqueue(async () => { const value: unknown = await transaction('readonly', store => store.get(ACTIVE_KEY)); if (value === undefined) return null; if (typeof value !== 'string') fail('数据库记录'); return importGame(value); });
}
export function clearGame(): Promise<void> { return enqueue(async () => { await transaction('readwrite', store => store.delete(ACTIVE_KEY)); }); }
