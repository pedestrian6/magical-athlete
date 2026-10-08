import { applyAction, createGame, getPlayerView } from '../game/engine';
import type { ActionInput, GameAction, GameConfig, GameState, PlayerView } from '../game/types';
import { getPublicGameView } from '../game/public';
import type { PublicGameView } from '../game/public';
import { loadGame, saveGame, exportGame, importGame } from './storage';
/** Local authority boundary. UI issues commands; only the rules core changes game state.
 * A future network transport runs this same core on its server and sends PlayerView.
 */
export interface LocalRulesSession {
  create(config:GameConfig):GameState;
  execute(state:GameState,action:GameAction):GameState;
  project(state:GameState,viewer:number|null):PlayerView;
}
export const localSession:LocalRulesSession={create:createGame,execute:applyAction,project:getPlayerView};

export interface LocalSnapshot {
  view: PublicGameView | null;
  saved: { race: number; phase: GameState['phase'] } | null;
  loading: boolean;
  saveStatus: string;
  error: string;
}
/** Owns local authority and persistence. React only receives display snapshots. */
export class LocalSession {
  private state: GameState | null = null;
  private saved: GameState | null = null;
  private viewer: number | null = null;
  private listeners = new Set<(snapshot: LocalSnapshot) => void>();
  private saving = Promise.resolve();
  private initializing: Promise<void> | null = null;
  private snapshot: LocalSnapshot = { view: null, saved: null, loading: true, saveStatus: '', error: '' };
  subscribe(listener: (snapshot: LocalSnapshot) => void) { this.listeners.add(listener); listener(this.snapshot); return () => { this.listeners.delete(listener); }; }
  private emit(changes: Partial<LocalSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...changes, view: this.state ? getPublicGameView(this.state, this.state.phase === 'selection' ? this.viewer : this.state.pending?.playerId ?? null) : null, saved: this.saved ? { race: this.saved.race, phase: this.saved.phase } : null };
    this.listeners.forEach(fn => fn(this.snapshot));
  }
  initialize() {
    if(!this.initializing) this.initializing = (async () => { try { this.saved = await loadGame(); this.emit({ loading: false }); } catch(e) { this.emit({ loading: false, error: `存档读取失败：${String(e)}` }); } })();
    return this.initializing;
  }
  private persist() {
    const state = this.state!; this.saved = state; this.emit({ saveStatus: '正在保存…', error: '' });
    this.saving = this.saving.catch(() => {}).then(() => saveGame(state)).then(() => { this.emit({ saveStatus: '已自动保存' }); }).catch(e => { this.emit({ saveStatus: '自动保存失败', error: `保存失败，请导出备份：${String(e)}` }); });
  }
  async create(config: GameConfig) { this.state = createGame(config); this.viewer = null; this.persist(); }
  async resume() { if(this.saved) { this.state = this.saved; this.viewer = null; this.emit({ error: '' }); } }
  async execute(action: ActionInput) {
    if(!this.state) throw new Error('请先开始游戏');
    this.state = applyAction(this.state, { ...action, id: crypto.randomUUID(), revision: this.state.revision });
    if(action.type === 'select' || action.type === 'nextRace') this.viewer = null;
    this.persist();
  }
  setViewer(viewer: number | null) { this.viewer = viewer; this.emit(); }
  async import(text: string) { this.state = importGame(text); this.viewer = null; this.persist(); }
  export() { const state = this.state ?? this.saved; return state ? { json: exportGame(state), race: state.race } : null; }
}
