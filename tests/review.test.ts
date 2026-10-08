import { describe, expect, it } from 'vitest';
import { createGame, applyAction, getPlayerView } from '../src/game/engine';
import { exportGame, importGame } from '../src/session/storage';
import type { ActionInput, GameState } from '../src/game/types';

function next(s: GameState, step: number): ActionInput {
  switch (s.phase) {
    case 'draft': return { type: 'draft', racerId: s.market[step % s.market.length] };
    case 'selection': { const p = s.players[s.selectionPlayer]; return { type: 'select', playerId: p.id, racerIds: p.team.filter(id => !p.used.includes(id)).slice(0, s.duo ? 2 : 1) }; }
    case 'reveal': return { type: 'reveal' };
    case 'race':
      if (s.pending) return { type: 'choose', decisionId: s.pending.id, optionId: s.pending.options[step % s.pending.options.length].id };
      return { type: s.paused ? 'continue' : 'roll' };
    case 'raceEnd': return { type: 'nextRace' };
    default: throw new Error('Already ended');
  }
}

describe('independent full-game and persistence review', () => {
  for (const [n, duo] of [[2,true], [3,false], [3,true], [4,false], [5,false], [6,false]] as const) {
    it(`${n} players, duo=${duo}: all four races finish and every state round-trips`, () => {
      for (const seed of [1, 2026, 123456]) {
        let s = createGame({ names: Array.from({length:n}, (_, i) => `P${i}`), duo, seed });
        for (let step = 0; step < 3000 && s.phase !== 'gameEnd'; step++) {
          try {
            s = applyAction(s, { ...next(s, step), id: `${seed}-${step}`, revision: s.revision });
            s = importGame(exportGame(s));
          } catch (e) { throw new Error(`seed=${seed}, step=${step}, phase=${s.phase}, turn=${s.turn?.actor}, pending=${s.pending?.task.kind}: ${String(e)}`); }
        }
        expect(s.phase, `seed=${seed}, pending=${s.pending?.task.kind}`).toBe('gameEnd');
        expect(s.results).toHaveLength(4);
      }
    });
  }
  it('other players and public view cannot learn locked selections from used cards', () => {
    let s = createGame({ names: ['A','B','C'], seed: 73 });
    while (s.phase === 'draft') s = applyAction(s, { type: 'draft', racerId: s.market[0], id: `draft-${s.revision}`, revision: s.revision });
    const owner = s.selectionPlayer, id = s.players[owner].team[0];
    s = applyAction(s, { type: 'select', playerId: owner, racerIds: [id], id: 'select-private', revision: s.revision });
    for (const viewer of [null, (owner + 1) % 3]) {
      const view = getPlayerView(s, viewer);
      expect(view.selections).toEqual({});
      expect(view.players[owner].used).not.toContain(id);
      expect(view).not.toHaveProperty('rng');
      expect(view).not.toHaveProperty('deck');
      expect(view.events.at(-1)?.message).not.toContain(id);
    }
    expect(getPlayerView(s, owner).selections).toEqual({[owner]: [id]});
  });
});

function stagedRace(ids: string[]): GameState {
  const s = createGame({ names: ids.map((_, i) => `P${i}`), seed: 73 });
  s.phase = 'reveal';
  // A fixture with explicit teams avoids depending on shuffled draft order.
  s.deck = ['copycat', 'coach', 'hare']; s.market = [];
  s.players.forEach((p, i) => { p.team = [ids[i]]; p.used = [ids[i]]; s.selections[p.id] = [ids[i]]; });
  s.firstPlayer = 0;
  return s;
}

describe('independent critical capability regression', () => {
  it('Egg copying Copycat participates in the tied-leader copying choice', () => {
    let s = stagedRace(['egg', 'legs', 'gunk']);
    s = applyAction(s, { type: 'reveal', id: 'reveal-egg', revision: s.revision });
    expect(s.pending?.task.kind).toBe('chooseEgg');
    s = applyAction(s, { type: 'choose', decisionId: s.pending!.id, optionId: 'copycat', id: 'egg-copycat', revision: s.revision });
    expect(s.pending?.task.kind).toBe('chooseCopy');
    expect(s.pending?.actor).toBe('egg');
  });
});
