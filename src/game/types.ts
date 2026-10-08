export type Phase = 'draft' | 'selection' | 'reveal' | 'race' | 'raceEnd' | 'gameEnd';
export interface Player { id: number; name: string; color: string; team: string[]; used: string[]; score: number; gold: number; silver: number }
export interface Racer { id: string; playerId: number; position: number; tripped: boolean; finished: number | null; eliminated: boolean; power: string | null; prediction?: string; eggBonus: boolean; copyTarget?: string; firstTurnTaken?: boolean; mimic?: boolean; copyLeaders?: string }
export interface GameEvent { id: number; type: string; message: string; racerId?: string; from?: number; to?: number; value?: number; race: number }
export interface MoveSpec { id: string; amount: number; teleport?: boolean; destination?: number; ignoreExact?: boolean; follow?: string }
export interface Trigger { kind: 'movement' | 'trip' | 'roll' | 'bonus'; actor: string; before?: Record<string, number>; after?: Record<string, number>; moved?: string[]; teleported?: string[]; value?: number; source?: string; bonus?: boolean }
export interface Task { kind: string; actor?: string; target?: string; ids?: string[]; amount?: number; value?: number; index?: number; text?: string; power?: string; moves?: MoveSpec[]; trigger?: Trigger; flags?: string[] }
export interface Decision { id: string; playerId: number; actor: string; title: string; description: string; options: { id: string; label: string }[]; task: Task }
export interface Turn { actor: string; number: number; stage: 'ready' | 'resolving'; rolled: number | null; startPosition: number; rollCount: number; usedMerchants: string[]; modifiers: number; base?: number; double?: boolean; skip?: boolean; guess?: number; extra?: boolean; nextOverride: string[] }
export interface RaceResult { race: number; track: 'mild' | 'wild'; standings: { racerId: string; playerId: number; place: number; points: number }[]; scores: number[] }
export interface GameState {
  schemaVersion: 1; rulesVersion: string; id: string; revision: number; rng: number; phase: Phase;
  players: Player[]; duo: boolean; race: number; track: 'mild' | 'wild';
  deck: string[]; market: string[]; draftOrder: number[]; draftIndex: number; draftBatch: number; firstPlayer: number;
  selectionPlayer: number; selections: Record<number, string[]>;
  racers: Racer[]; turnOrder: string[]; turn: Turn | null; queue: Task[]; pending: Decision | null;
  events: GameEvent[]; results: RaceResult[]; raceStartScores: number[]; finishOrder: string[];
  processedActions: string[]; chainSeen: string[]; paused: boolean;
}
export interface GameConfig { names: string[]; duo?: boolean; seed?: number }
export type ActionInput =
  | { type: 'draft'; racerId: string }
  | { type: 'select'; playerId: number; racerIds: string[] }
  | { type: 'reveal' } | { type: 'roll' }
  | { type: 'choose'; decisionId: string; optionId: string }
  | { type: 'nextRace' } | { type: 'continue' };
export type GameAction = ActionInput & { id: string; revision: number };
export type PlayerView = Omit<GameState, 'deck' | 'rng' | 'selections' | 'queue' | 'chainSeen' | 'processedActions'> & { selections: Record<number, string[]>; deckCount: number };
