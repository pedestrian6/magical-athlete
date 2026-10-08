import { describe, expect, it } from 'vitest';
import { RACERS, RULES_VERSION } from '../src/game/content';
import { exportGame, importGame, saveGame, validateGameState } from '../src/session/storage';
import type { GameState } from '../src/game/types';

function fixture(): GameState {
  const ids = Object.keys(RACERS);
  return {
    schemaVersion: 1, rulesVersion: RULES_VERSION, id: 'storage-test', revision: 0, rng: 42,
    phase: 'draft', players: [0, 1, 2].map(id => ({ id, name: `玩家 ${id + 1}`, color: '#ff0000', team: [], used: [], score: 0, gold: 0, silver: 0 })),
    duo: false, race: 0, track: 'mild', deck: ids.slice(5), market: ids.slice(0, 5), draftOrder: [0, 1, 2], draftIndex: 0, draftBatch: 0,
    firstPlayer: 0, selectionPlayer: 0, selections: {}, racers: [], turnOrder: [], turn: null, queue: [], pending: null,
    events: [], results: [], raceStartScores: [0, 0, 0], finishOrder: [], processedActions: [], chainSeen: [], paused: false,
  };
}
function editEnvelope(edit: (envelope: any) => void): string { const envelope = JSON.parse(exportGame(fixture())); edit(envelope); return JSON.stringify(envelope); }

describe('versioned local saves', () => {
  it('round-trips all state without aliasing the original', () => {
    const state = fixture(); const loaded = importGame(exportGame(state));
    expect(loaded).toEqual(state); expect(loaded).not.toBe(state);
    loaded.players[0].name = 'changed'; expect(state.players[0].name).toBe('玩家 1');
  });
  it('rejects future schema and different rule versions', () => {
    expect(() => importGame(editEnvelope(e => { e.schemaVersion = 2; }))).toThrow(/版本/);
    expect(() => importGame(editEnvelope(e => { e.state.schemaVersion = 2; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.rulesVersion = 'future'; }))).toThrow(/版本/);
    expect(() => importGame(editEnvelope(e => { e.state.rulesVersion = 'future'; }))).toThrow();
  });
  it('rejects malformed JSON, oversized input and unexpected properties', () => {
    expect(() => importGame('{bad')).toThrow(/JSON/);
    expect(() => importGame(' '.repeat(5 * 1024 * 1024 + 1))).toThrow(/5 MB/);
    expect(() => importGame(editEnvelope(e => { e.state.callback = 'execute'; }))).toThrow();
    expect(() => importGame('{"__proto__":{},"schemaVersion":1}')).toThrow();
  });
  it('validates finite integer state, player identities and card membership', () => {
    expect(() => importGame(editEnvelope(e => { e.state.rng = -1; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.players[0].score = 0.5; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.players[0].id = 5; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.market[0] = 'imaginary-racer'; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.phase = 'execute'; }))).toThrow();
    const s = fixture(); s.rng = NaN; expect(() => validateGameState(s)).toThrow();
  });
  it('rejects unowned selections and cross references', () => {
    expect(() => importGame(editEnvelope(e => { e.state.selections = { 0: [Object.keys(RACERS)[0]] }; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.turnOrder = [Object.keys(RACERS)[0]]; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.queue = [{ kind: 'arbitraryCode' }]; }))).toThrow();
  });
  it('rejects incomplete race states and empty pending decisions', () => {
    expect(() => importGame(editEnvelope(e => { e.state.phase = 'race'; }))).toThrow();
    expect(() => importGame(editEnvelope(e => { e.state.pending = { id: 'x', playerId: 0, actor: Object.keys(RACERS)[0], title: '选择', description: '', options: [], task: { kind: 'move' } }; }))).toThrow();
  });
  it('reports unsupported storage instead of claiming a successful save', async () => {
    if (typeof indexedDB === 'undefined') await expect(saveGame(fixture())).rejects.toThrow(/IndexedDB/);
  });
});

export function raceFixture(): GameState {
  const state = fixture(); const ids = state.market.slice(0, 3);
  state.market = state.market.slice(3);
  state.players.forEach((p, i) => { p.team = [ids[i]]; p.used = [ids[i]]; state.selections[p.id] = [ids[i]]; });
  state.phase = 'race'; state.racers = ids.map((id, playerId) => ({ id, playerId, position: 4, tripped: false, finished: null, eliminated: false, power: id, eggBonus: false }));
  state.turnOrder = ids;
  state.turn = { actor: ids[0], number: 4, stage: 'resolving', rolled: 4, startPosition: 0, rollCount: 1, usedMerchants: [], modifiers: 0, nextOverride: [] };
  state.queue = [{ kind: 'move', actor: ids[0], moves: [{ id: ids[0], amount: 4 }] }, { kind: 'endTurn', actor: ids[0] }];
  state.pending = { id: 'decision-4', playerId: 0, actor: ids[0], title: '是否重掷？', description: '选择后继续结算', options: [{ id: 'keep', label: '保留' }], task: { kind: 'chooseReroll', actor: ids[0] } };
  state.processedActions = ['action-1']; state.chainSeen = ['movement:1']; state.rng = 0xdeadbeef;
  return state;
}

describe('mid-resolution saves', () => {
  it('retains pending decision, complete task queue, RNG and action deduplication state', () => {
    const state = raceFixture(); const loaded = importGame(exportGame(state));
    expect(loaded).toEqual(state);
    loaded.queue[0].moves![0].amount = 5;
    expect(state.queue[0].moves![0].amount).toBe(4);
  });
  it('rejects a missing decision target, unknown task and duplicated options', () => {
    const missing = raceFixture(); missing.queue[0].actor = Object.keys(RACERS).find(id => !missing.turnOrder.includes(id))!;
    expect(() => validateGameState(missing)).toThrow();
    const unknown = raceFixture(); unknown.queue[0].kind = 'unsupported'; expect(() => validateGameState(unknown)).toThrow();
    const duplicate = raceFixture(); duplicate.pending!.options.push(duplicate.pending!.options[0]); expect(() => validateGameState(duplicate)).toThrow();
  });
});

describe('execution-safe imported decisions', () => {
  it('rejects absent required task fields and unimplemented task kinds', () => {
    for (const task of [{ kind: 'startTurn' }, { kind: 'reaction', actor: 'alchemist' }, { kind: 'space', actor: 'alchemist' }, { kind: 'rollReaction', actor: 'alchemist' }, { kind: 'move' }, { kind: 'endReaction', actor: 'alchemist' }, { kind: 'endAbility', actor: 'alchemist' }, { kind: 'babyBanana', actor: 'alchemist' }]) {
      const s = raceFixture(); s.queue = [task]; expect(() => validateGameState(s), task.kind).toThrow();
    }
  });
  it('separates queued effects from decisions and validates decision owner', () => {
    const effect = raceFixture(); effect.pending!.task = { kind: 'move', moves: [] }; expect(() => validateGameState(effect)).toThrow();
    const choice = raceFixture(); choice.queue = [{ kind: 'chooseReroll', actor: choice.racers[0].id }]; expect(() => validateGameState(choice)).toThrow();
    const owner = raceFixture(); owner.pending!.playerId = 1; expect(() => validateGameState(owner)).toThrow();
  });
  it('rejects options that would address missing racers or convert into NaN', () => {
    for (const [kind, power, option] of [['chooseMain', 'flip_flop', 'missing'], ['chooseStart', 'third_wheel', 'NaN'], ['chooseReroll', undefined, 'missing'], ['chooseGuess', undefined, '7']] as const) {
      const s = raceFixture(); s.pending!.task = { kind, actor: s.racers[0].id, ...(power ? {power} : {}) }; s.pending!.options = [{id: option, label: '非法选项'}];
      expect(() => validateGameState(s), kind).toThrow();
    }
  });
  it('requires complete movement snapshots and resolvable following chains', () => {
    const incomplete = raceFixture(); incomplete.queue = [{kind: 'reaction', actor: incomplete.racers[0].id, trigger: {kind: 'movement', actor: incomplete.racers[0].id}}]; expect(() => validateGameState(incomplete)).toThrow();
    const missing = raceFixture(); missing.queue = [{kind:'move', moves:[{id:missing.racers[0].id, amount:1, follow:missing.racers[1].id}]}]; expect(() => validateGameState(missing)).toThrow();
    const nested = raceFixture(); const [a,b,c] = nested.racers.map(r => r.id);
    nested.queue = [{kind:'move', moves:[{id:a,amount:1},{id:b,amount:1,follow:a},{id:c,amount:1,follow:b}]}];
    expect(importGame(exportGame(nested))).toEqual(nested);
  });
  it('rejects out-of-range rounds and non-resumable race stages', () => {
    const round = raceFixture(); round.race = 4; expect(() => validateGameState(round)).toThrow();
    const stalled = raceFixture(); stalled.pending = null; stalled.queue = []; expect(() => validateGameState(stalled)).toThrow();
  });
});

it('persists the banana reaction after a Huge Baby placement', () => {
  const s = raceFixture(); s.queue = [{kind:'babyBanana', actor:s.racers[0].id, target:s.racers[1].id}];
  expect(importGame(exportGame(s))).toEqual(s);
});
