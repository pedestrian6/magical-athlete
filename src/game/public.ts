import type { GameEvent, GameState, Phase, Player, RaceResult, Racer, Turn } from './types';

export interface PublicDecision {
  id: string;
  playerId: number;
  actor: string;
  title: string;
  description: string;
  options: { id: string; label: string }[];
}
export type PublicRacer = Pick<Racer, 'id' | 'playerId' | 'position' | 'tripped' | 'finished' | 'eliminated' | 'power' | 'prediction' | 'copyTarget'>;
/** Wire projection: adding engine state fields never exposes them automatically. */
export interface PublicGameView {
  schemaVersion: 1;
  rulesVersion: string;
  id: string;
  revision: number;
  phase: Phase;
  players: Player[];
  duo: boolean;
  race: number;
  track: 'mild' | 'wild';
  market: string[];
  deckCount: number;
  draftOrder: number[];
  draftIndex: number;
  draftBatch: number;
  firstPlayer: number;
  selectionPlayer: number;
  selections: Record<number, string[]>;
  lockedPlayerIds: number[];
  racers: PublicRacer[];
  turnOrder: string[];
  turn: Pick<Turn, 'actor' | 'number' | 'stage' | 'rolled'> | null;
  pending: PublicDecision | null;
  events: GameEvent[];
  results: RaceResult[];
  raceStartScores: number[];
  finishOrder: string[];
  paused: boolean;
}

// Only public presentation events are sent. Egg candidates are never logged;
// the chosen, now-active ability is public once its owner confirms the choice.
const PUBLIC_EVENT_TYPES = new Set([
  'die', 'order', 'ability', 'score', 'race', 'finish', 'raceEnd', 'copy', 'trip',
  'move', 'teleport', 'eliminate', 'rule', 'turn', 'skip', 'stand', 'modifier',
  'choice', 'pause', 'loop', 'draft', 'selection',
]);

export function getPublicGameView(s: GameState, viewerId: number | null): PublicGameView {
  const hidden = s.phase === 'selection';
  const selections: Record<number, string[]> = {};
  for (const p of s.players) {
    if (s.selections[p.id] && (!hidden || p.id === viewerId)) selections[p.id] = [...s.selections[p.id]];
  }
  const d = s.pending;
  const ownsDecision = d !== null && d.playerId === viewerId;
  return {
    schemaVersion: s.schemaVersion,
    rulesVersion: s.rulesVersion,
    // Legacy offline identifiers contain the seed. Network games use an
    // independent gameId supplied by their server when creating the game.
    id: /^game-\d+$/.test(s.id) ? 'local-game' : s.id,
    revision: s.revision,
    phase: s.phase,
    players: s.players.map(p => ({
      id: p.id, name: p.name, color: p.color, team: [...p.team],
      used: p.used.filter(id => !hidden || !(s.selections[p.id] ?? []).includes(id)),
      score: p.score, gold: p.gold, silver: p.silver,
    })),
    duo: s.duo, race: s.race, track: s.track,
    market: [...s.market], deckCount: s.deck.length,
    draftOrder: [...s.draftOrder], draftIndex: s.draftIndex, draftBatch: s.draftBatch,
    firstPlayer: s.firstPlayer, selectionPlayer: s.selectionPlayer,
    selections, lockedPlayerIds: s.players.filter(p => Object.hasOwn(s.selections, p.id)).map(p => p.id),
    racers: s.racers.map(r => ({
      id: r.id, playerId: r.playerId, position: r.position, tripped: r.tripped,
      finished: r.finished, eliminated: r.eliminated, power: r.power,
      ...(r.prediction === undefined ? {} : { prediction: r.prediction }),
      ...(r.copyTarget === undefined ? {} : { copyTarget: r.copyTarget }),
    })),
    turnOrder: [...s.turnOrder],
    turn: s.turn ? { actor: s.turn.actor, number: s.turn.number, stage: s.turn.stage, rolled: s.turn.rolled } : null,
    pending: d ? {
      id: d.id, playerId: d.playerId, actor: d.actor, title: d.title,
      description: ownsDecision ? d.description : '',
      options: ownsDecision ? d.options.map(o => ({ id: o.id, label: o.label })) : [],
    } : null,
    events: s.events.filter(e => PUBLIC_EVENT_TYPES.has(e.type)).map(e => ({
      id: e.id, type: e.type, message: e.message, race: e.race,
      ...(e.racerId === undefined ? {} : { racerId: e.racerId }),
      ...(e.from === undefined ? {} : { from: e.from }),
      ...(e.to === undefined ? {} : { to: e.to }),
      ...(e.value === undefined ? {} : { value: e.value }),
    })),
    results: s.results.map(result => ({
      race: result.race, track: result.track, scores: [...result.scores],
      standings: result.standings.map(r => ({ racerId: r.racerId, playerId: r.playerId, place: r.place, points: r.points })),
    })),
    raceStartScores: [...s.raceStartScores], finishOrder: [...s.finishOrder], paused: s.paused,
  };
}
