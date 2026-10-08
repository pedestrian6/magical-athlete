import { expect, it } from 'vitest';
import { applyAction, createGame } from '../src/game/engine';
import type { ActionInput, GameState, Task } from '../src/game/types';

let nonce = 0;
const act = (s: GameState, a: ActionInput) => applyAction(s, { ...a, id: `review-${++nonce}`, revision: s.revision });
function fixture(ids: string[], positions: number[]): GameState {
  const s = createGame({ names: ids.map((_, i) => `P${i}`), seed: 321 });
  s.phase = 'race'; s.deck = []; s.market = []; s.firstPlayer = 0; s.duo = false;
  s.racers = ids.map((id, i) => ({ id, playerId: i, position: positions[i], tripped: false, finished: null, eliminated: false, power: id, eggBonus: false }));
  s.players.forEach((p, i) => { p.team = [ids[i]]; p.used = []; p.score = 0; });
  s.turnOrder = ids; s.queue = []; s.pending = null; s.finishOrder = []; s.results = []; s.events = []; s.chainSeen = [];
  s.turn = { actor: ids[0], number: 1, stage: 'ready', rolled: null, startPosition: positions[0], rollCount: 0, usedMerchants: [], modifiers: 0, nextOverride: [] };
  return s;
}
function run(s: GameState, ...tasks: Task[]) { s.queue = tasks; s.paused = true; return act(s, { type: 'continue' }); }
function pick(s: GameState, optionId: string) { expect(s.pending).not.toBeNull(); return act(s, { type: 'choose', decisionId: s.pending!.id, optionId }); }

// IELLO FAQ 2.0, Gros Bébé: pushing Banana away on arrival still counts as passing it.
it('规则复核：巨婴停到香蕉格并推开香蕉时，巨婴仍绊倒', () => {
  const s = run(fixture(['huge_baby', 'banana', 'legs'], [2, 4, 9]), { kind: 'move', moves: [{ id: 'huge_baby', amount: 2 }] });
  expect(s.racers.find(r => r.id === 'banana')!.position).toBe(3);
  expect(s.racers.find(r => r.id === 'huge_baby')!.tripped).toBe(true);
});

// Egg gets all copied ability text, including Copycat's continuously active ability.
it('规则复核：蛋蛋选择模仿猫后也应随领先者变化复制能力', () => {
  let s = fixture(['egg', 'legs', 'banana'], [0, 4, 1]);
  s.deck = ['copycat', 'coach', 'gunk'];
  s = run(s, { kind: 'preRace', actor: 'egg' }, { kind: 'copyCheck' });
  s = pick(s, 'copycat');
  expect(s.racers.find(r => r.id === 'egg')!.power).toBe('legs');
});

// FAQ Suckerfish: the followed racer is processed first for consequences; on an
// arrow fish may follow it again, or stay to resolve its own arrow afterwards.
it('规则复核：吸盘鱼先于领行者座位时，箭头仍先结算领行者', () => {
  let s = fixture(['suckerfish', 'legs', 'banana'], [4, 4, 0]);
  s.track = 'wild';
  s = run(s, { kind: 'move', moves: [{ id: 'legs', amount: 3 }] });
  s = pick(s, 'legs');
  expect(s.pending?.actor).toBe('suckerfish');
  expect(s.pending?.task.kind).toBe('chooseFollow');
  expect(s.racers.find(r => r.id === 'suckerfish')!.position).toBe(7);
});

// Rulebook p18: earliest eliminated racer takes precedence over last-on-track.
it('规则复核：最先被淘汰的玩家应获得下一场先手', () => {
  let s = fixture(['mouth', 'legs', 'banana', 'coach'], [0, 3, 1, 7]);
  s = run(s, { kind: 'move', moves: [{ id: 'mouth', amount: 3 }] });
  expect(s.racers.find(r => r.id === 'legs')!.eliminated).toBe(true);
  s = run(s, { kind: 'move', moves: [{ id: 'mouth', amount: 30 }] });
  s = run(s, { kind: 'move', moves: [{ id: 'coach', amount: 30 }] });
  expect(s.phase).toBe('raceEnd');
  s = act(s, { type: 'nextRace' });
  expect(s.firstPlayer).toBe(1);
});

// FAQ Timing gives this exact priority example: Romantic is the active racer,
// so it leaves first and Duelist no longer has a legal opportunity.
it('规则复核：双角色模式同一玩家的当前运动员优先于其另一名角色', () => {
  let s = fixture(['duelist', 'romantic', 'legs'], [3, 1, 10]);
  s.duo = true;
  s.racers[1].playerId = 0;
  s.turn!.actor = 'romantic';
  s.turn!.startPosition = 1;
  s = run(s, { kind: 'move', moves: [{ id: 'romantic', amount: 2 }] });
  expect(s.racers.find(r => r.id === 'romantic')!.position).toBe(5);
  expect(s.pending).toBeNull();
});

// Stickler actually applying its cancellation is another athlete's power
// happening, just as a Gunk modifier applies even if it prevents advancement.
it('规则复核：较真怪取消过量移动时，应触发蹭蹭怪', () => {
  const s = run(fixture(['legs', 'stickler', 'scoocher'], [28, 4, 10]), { kind: 'move', moves: [{ id: 'legs', amount: 3 }] });
  expect(s.racers.find(r => r.id === 'legs')!.position).toBe(28);
  expect(s.racers.find(r => r.id === 'scoocher')!.position).toBe(11);
});

// Copycat chooses when the leader set changes to a tie, even if the previous
// copied leader remains a legal option; keeping that option is not compulsory.
it('规则复核：新增并列领先者时，模仿猫应能重新选择', () => {
  let s = fixture(['copycat', 'coach', 'legs'], [0, 5, 4]);
  s = run(s, { kind: 'copyCheck' });
  expect(s.racers[0].power).toBe('coach');
  s = run(s, { kind: 'move', moves: [{ id: 'legs', amount: 1 }] });
  expect(s.pending?.task.kind).toBe('chooseCopy');
  expect(s.pending?.options.map(o => o.id)).toEqual(['coach', 'legs']);
});

it('规则复核：同玩家两个船长按固定顺序接续，之后回到下一位', () => {
  let s = fixture(['legs', 'skipper', 'egg', 'banana'], [0, 2, 4, 15]);
  s.duo = true;
  s.racers[2].playerId = 1;
  s.racers[2].power = 'skipper';
  s.turn!.rolled = 1;
  s = run(s, { kind: 'resolveRoll', actor: 'legs' }, { kind: 'advance', actor: 'legs' });
  expect(s.turn!.actor).toBe('skipper');
  s.turn!.rolled = 2;
  s = run(s, { kind: 'resolveRoll', actor: 'skipper' }, { kind: 'advance', actor: 'skipper' });
  expect(s.turn!.actor).toBe('egg');
  s.turn!.rolled = 2;
  s = run(s, { kind: 'resolveRoll', actor: 'egg' }, { kind: 'advance', actor: 'egg' });
  expect(s.turn!.actor).toBe('banana');
});
