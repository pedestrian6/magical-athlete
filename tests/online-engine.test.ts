import { describe, expect, it, vi } from 'vitest';
import { applyAction, createGame, type EngineOptions } from '../src/game/engine';
import { getPublicGameView } from '../src/game/public';
import type { ActionInput, GameAction, GameState } from '../src/game/types';

let nonce = 0;
function act(s: GameState, action: ActionInput, options: EngineOptions = {}) {
  return applyAction(s, { ...action, id: `online-${++nonce}`, revision: s.revision }, options);
}
function selectionFixture(duo = false) {
  const s = createGame({ names: ['A', 'B', 'C'], duo, seed: 73 });
  s.phase = 'selection'; s.firstPlayer = 0; s.selectionPlayer = 0;
  s.players[0].team = ['legs', 'coach', 'twin', 'egg'];
  s.players[1].team = ['banana', 'hare', 'genius', 'alchemist'];
  s.players[2].team = ['duelist', 'sisyphus', 'mastermind', 'gunk'];
  return s;
}
function raceFixture(ids = ['twin', 'legs', 'gunk']) {
  const s = createGame({ names: ids.map((_, i) => `P${i}`), seed: 73 });
  s.phase = 'race'; s.events = []; s.rng = 0; s.deck = []; s.market = [];
  s.racers = ids.map((id, playerId) => ({ id, playerId, position: 0, tripped: false, finished: null, eliminated: false, power: id, eggBonus: false }));
  s.players.forEach((p, i) => { p.team = [ids[i]]; p.used = [ids[i]]; s.selections[p.id] = [ids[i]]; });
  s.turnOrder = [...ids];
  s.turn = { actor: ids[0], number: 1, stage: 'ready', rolled: null, startPosition: 0, rollCount: 0, usedMerchants: [], modifiers: 0, nextOverride: [] };
  return s;
}
function nextAction(s: GameState): ActionInput {
  if (s.phase === 'draft') return { type: 'draft', racerId: s.market[0] };
  if (s.phase === 'selection') {
    const p = [...s.players].reverse().find(p => !Object.hasOwn(s.selections, p.id))!;
    return { type: 'select', playerId: p.id, racerIds: p.team.filter(id => !p.used.includes(id)).slice(0, s.duo ? 2 : 1) };
  }
  if (s.phase === 'reveal') return { type: 'reveal' };
  if (s.phase === 'raceEnd') return { type: 'nextRace' };
  if (s.pending) {
    const choice = s.pending.options.find(o => o.id === 'skip') ?? s.pending.options.find(o => o.id === 'keep') ?? s.pending.options[0];
    return { type: 'choose', decisionId: s.pending.id, optionId: choice.id };
  }
  return { type: s.paused ? 'continue' : 'roll' };
}

describe('injected authoritative randomness', () => {
  it('leaves seeded local behavior unchanged when options are omitted', () => {
    const config = { names: ['A', 'B', 'C'], seed: 20261003 };
    expect(createGame(config)).toEqual(createGame(config, {}));
    const s = raceFixture(), action: GameAction = { type: 'roll', revision: s.revision, id: 'same' };
    expect(applyAction(s, action)).toEqual(applyAction(s, action, {}));
  });

  it('records shuffle and all dice draws, replays them, and persists a cursor', () => {
    const tape: { max: number; value: number }[] = [];
    const config = { names: ['A', 'B', 'C'], seed: 42 };
    const gameId = 'independent-public-id';
    const s = createGame(config, { gameId, drawInt: max => {
      const value = tape.length % max; tape.push({ max, value }); return value;
    } });
    expect(s.id).toBe(gameId);
    expect(tape.slice(0, 35).map(d => d.max)).toEqual(Array.from({ length: 35 }, (_, i) => 36 - i));
    expect(s.rng).toBe(tape.length);
    let cursor = 0;
    const replay = createGame(config, { gameId, drawInt: max => {
      const draw = tape[cursor++]; expect(draw.max).toBe(max); return draw.value;
    } });
    expect(replay).toEqual(s); expect(cursor).toBe(tape.length);
  });

  it.each([-1, 6, 1.5, NaN, Infinity])('rejects invalid dice output %s without mutating the prior state', value => {
    const s = raceFixture(), original = structuredClone(s);
    expect(() => act(s, { type: 'roll' }, { drawInt: () => value })).toThrow('随机抽样结果无效');
    expect(s).toEqual(original);
  });

  it('uses the provider during normal rolls, resumed tasks, and duel choices', () => {
    const drawInt = vi.fn(() => 3);
    const rolled = act(raceFixture(), { type: 'roll' }, { drawInt });
    expect(rolled.events.find(e => e.type === 'die')?.value).toBe(4);
    expect(rolled.rng).toBe(1); expect(drawInt).toHaveBeenCalledWith(6);
    const queued = raceFixture(); queued.paused = true; queued.queue = [{ kind: 'rollDie', actor: 'twin' }];
    expect(act(queued, { type: 'continue' }, { drawInt }).rng).toBe(1);
    const duel = raceFixture(['duelist', 'twin', 'legs']);
    duel.pending = { id: 'duel', playerId: 0, actor: 'duelist', title: '决斗', description: '', options: [{ id: 'twin', label: '双胞胎' }], task: { kind: 'chooseDuel', actor: 'duelist' } };
    expect(act(duel, { type: 'choose', decisionId: 'duel', optionId: 'twin' }, { drawInt }).rng).toBe(2);
  });

  it('does not sample again when an acknowledged action is retried', () => {
    const s = raceFixture(), drawInt = vi.fn(() => 3);
    const action: GameAction = { type: 'roll', id: 'retry-same-id', revision: s.revision };
    const next = applyAction(s, action, { drawInt });
    expect(applyAction(next, action, { drawInt })).toBe(next);
    expect(drawInt).toHaveBeenCalledTimes(1);
  });

  for (const [count, duo] of [[2, true], [3, false], [3, true], [4, false], [5, false], [6, false]] as const) {
    it(`replays a complete ${count}-player ${duo ? 'duo' : 'standard'} online game from private draws`, () => {
      const tape: { max: number; value: number }[] = [], actions: GameAction[] = [];
      // Reuse the known full-game regression dice stream as a test provider;
      // production supplies crypto.randomInt rather than this seeded fixture.
      let testRandomState = 936 + count;
      const options: EngineOptions = { gameId: `room-${count}-${duo}`, selectionMode: 'simultaneous', drawInt: max => {
        testRandomState ^= testRandomState << 13;
        testRandomState ^= testRandomState >>> 17;
        testRandomState ^= testRandomState << 5;
        testRandomState >>>= 0;
        const value = Math.floor(testRandomState / 4294967296 * max); tape.push({ max, value }); return value;
      } };
      const config = { names: Array.from({ length: count }, (_, i) => `P${i}`), duo };
      let s = createGame(config, options);
      while (s.phase !== 'gameEnd' && actions.length < 1000) {
        const action = { ...nextAction(s), id: `action-${actions.length}`, revision: s.revision };
        actions.push(action); s = applyAction(s, action, options);
      }
      expect(s.phase).toBe('gameEnd'); expect(s.results).toHaveLength(4);
      let cursor = 0;
      const replayOptions = { ...options, drawInt: (max: number) => {
        const draw = tape[cursor++]; expect(draw.max).toBe(max); return draw.value;
      } };
      let replay = createGame(config, replayOptions);
      for (const action of actions) replay = applyAction(JSON.parse(JSON.stringify(replay)), action, replayOptions);
      expect(replay).toEqual(s); expect(cursor).toBe(tape.length); expect(s.rng).toBe(tape.length);
    });
  }
});

describe('simultaneous private selection', () => {
  const options: EngineOptions = { selectionMode: 'simultaneous' };
  it('keeps sequential local selection and rejects out-of-order choices by default', () => {
    expect(() => act(selectionFixture(), { type: 'select', playerId: 2, racerIds: ['duelist'] })).toThrow();
    expect(act(selectionFixture(), { type: 'select', playerId: 0, racerIds: ['legs'] }).selectionPlayer).toBe(1);
  });
  it('accepts arbitrary players, prevents replacement locks, and reveals only after all submit', () => {
    let s = act(selectionFixture(), { type: 'select', playerId: 2, racerIds: ['duelist'] }, options);
    expect(s.phase).toBe('selection');
    expect(() => act(s, { type: 'select', playerId: 2, racerIds: ['sisyphus'] }, options)).toThrow('已锁定');
    s = act(s, { type: 'select', playerId: 0, racerIds: ['legs'] }, options);
    expect(s.phase).toBe('selection');
    s = act(s, { type: 'select', playerId: 1, racerIds: ['banana'] }, options);
    expect(s.phase).toBe('reveal'); expect(getPublicGameView(s, null).selections).toEqual(s.selections);
  });
  it('preserves duo order and firstPlayer independently of lock order', () => {
    let s = selectionFixture(true); s.firstPlayer = 1;
    s = act(s, { type: 'select', playerId: 2, racerIds: ['sisyphus', 'duelist'] }, options);
    s = act(s, { type: 'select', playerId: 1, racerIds: ['hare', 'banana'] }, options);
    s = act(s, { type: 'select', playerId: 0, racerIds: ['coach', 'legs'] }, options);
    s = act(s, { type: 'reveal' }, options);
    expect(s.turnOrder).toEqual(['hare', 'banana', 'sisyphus', 'duelist', 'coach', 'legs']);
  });
  it('still rejects stale revisions so only the trusted room layer may safely rebase a lock', () => {
    const s = act(selectionFixture(), { type: 'select', playerId: 2, racerIds: ['duelist'] }, options);
    expect(() => applyAction(s, { type: 'select', playerId: 1, racerIds: ['banana'], id: 'stale', revision: s.revision - 1 }, options)).toThrow('过期');
  });
});

describe('public wire projection', () => {
  it('hides unannounced selection through all player views and broadcasts only lock status', () => {
    const s = act(selectionFixture(), { type: 'select', playerId: 2, racerIds: ['duelist'] }, { selectionMode: 'simultaneous' });
    for (const viewer of [null, 0, 1]) {
      const view = getPublicGameView(s, viewer);
      expect(view.selections).toEqual({}); expect(view.players[2].used).not.toContain('duelist');
      expect(view.lockedPlayerIds).toEqual([2]);
    }
    expect(getPublicGameView(s, 2).selections).toEqual({ 2: ['duelist'] });
  });
  it('hides Egg candidates, decision instructions, and internal tasks from nonowners', () => {
    let s = raceFixture(['egg', 'twin', 'legs']); s.deck = ['sisyphus', 'alchemist', 'genius'];
    s.paused = true; s.queue = [{ kind: 'preRace', actor: 'egg' }];
    s = act(s, { type: 'continue' });
    s.pending!.description = 'private instructions';
    expect(getPublicGameView(s, 0).pending?.options).toHaveLength(3);
    for (const viewer of [null, 1, 2]) {
      const view = getPublicGameView(s, viewer), json = JSON.stringify(view);
      expect(view.pending?.title).toBe('蛋蛋：选择孵化的能力');
      expect(view.pending?.options).toEqual([]); expect(view.pending?.description).toBe('');
      for (const hidden of ['sisyphus', 'alchemist', 'genius', 'private instructions']) expect(json).not.toContain(hidden);
    }
    expect(getPublicGameView(s, 0).pending).not.toHaveProperty('task');
    s = act(s, { type: 'choose', decisionId: s.pending!.id, optionId: 'sisyphus' });
    expect(getPublicGameView(s, 1).racers[0].power).toBe('sisyphus');
    expect(JSON.stringify(getPublicGameView(s, 1))).not.toContain('alchemist');
  });
  it('uses explicit nested whitelists, redacts legacy seeded IDs, and returns detached arrays', () => {
    const s = raceFixture();
    Object.assign(s, { futureSecret: 'secret' });
    Object.assign(s.players[0], { recoveryToken: 'secret' });
    Object.assign(s.racers[0], { futureSecret: 'secret' });
    s.events.push({ id: 1, type: 'private', message: 'secret', race: 0 });
    const view = getPublicGameView(s, 0);
    expect(view.id).toBe('local-game');
    for (const key of ['rng', 'deck', 'queue', 'chainSeen', 'processedActions', 'futureSecret']) expect(view).not.toHaveProperty(key);
    expect(Object.keys(view.turn!).sort()).toEqual(['actor', 'number', 'rolled', 'stage']);
    expect(JSON.stringify(view)).not.toContain('secret');
    view.players[0].team.push('changed'); view.racers[0].position = 99;
    expect(s.players[0].team).not.toContain('changed'); expect(s.racers[0].position).toBe(0);
    s.id = 'room-independent-id'; expect(getPublicGameView(s, null).id).toBe(s.id);
  });
});
