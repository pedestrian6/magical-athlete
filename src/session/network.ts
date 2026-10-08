import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION, type CommandAck, type RoomCommand, type RoomCommandInput, type RoomView, type RoomSummary, type SeatAccess } from './protocol';

export type ConnectionState = 'connecting' | 'connected' | 'offline' | 'revoked';
export interface NetworkSnapshot { room: RoomView | null; connection: ConnectionState; pending: boolean; error: string }
export async function roomRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data: T & { error?: string };
  try { data = await response.json(); } catch { throw new Error('联机服务暂不可用。本地同机模式仍可正常使用。'); }
  if(!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
export const onlineApi = {
  session: () => roomRequest<{ rooms: RoomSummary[] }>('/session'),
  create: (name: string, capacity: number, duo: boolean) => roomRequest<SeatAccess>('/rooms', { name, capacity, duo }),
  join: (code: string, name: string) => roomRequest<SeatAccess>(`/rooms/${encodeURIComponent(code)}/join`, { name }),
  recover: (code: string, recoveryCode: string) => roomRequest<SeatAccess>(`/rooms/${encodeURIComponent(code)}/recover`, { recoveryCode }),
  recovery: (code: string) => roomRequest<SeatAccess>(`/rooms/${encodeURIComponent(code)}/recovery`, {}),
};

/** Commands stay single-flight and retain their ID across retry/reload. */
export class NetworkSession {
  private socket: Socket;
  private listeners = new Set<(snapshot: NetworkSnapshot) => void>();
  private snapshot: NetworkSnapshot = { room: null, connection: 'connecting', pending: false, error: '' };
  private command: RoomCommand | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly key: string;
  private disposed = false;
  private offline = () => { if(this.disposed || this.snapshot.connection === 'revoked') return; this.socket.disconnect(); this.emit({ connection: 'offline' }); this.clearTimer(); };
  private online = () => { if(!this.disposed && this.snapshot.connection !== 'revoked') this.socket.connect(); };
  constructor(readonly code: string) {
    this.key = `magical-athlete-pending-${code}`;
    try { const old = sessionStorage.getItem(this.key); if(old) { const command = JSON.parse(old) as RoomCommand; if(command.roomCode === code && command.protocolVersion === PROTOCOL_VERSION && typeof command.id === 'string') this.command = command; } } catch { /* private mode may disable storage */ }
    this.snapshot.pending = !!this.command;
    const pageId = crypto.randomUUID();
    this.socket = io({ autoConnect: false, auth: { roomCode: code, pageId, claim: true } });
    this.socket.on('connect', () => { this.socket.auth = { roomCode: code, pageId, claim: false }; this.emit({ connection: 'connected', error: '' }); this.socket.emit('sync'); });
    this.socket.on('room', (room: RoomView) => {
      if(room.protocolVersion !== PROTOCOL_VERSION) { this.revoke('客户端版本不兼容，请刷新页面。'); return; }
      if(this.snapshot.room && room.revision < this.snapshot.room.revision) return;
      this.emit({ room, connection: 'connected' });
      if(this.command && !this.retryTimer) this.flush();
    });
    this.socket.on('disconnect', () => { if(this.snapshot.connection !== 'revoked' && !this.disposed) this.emit({ connection: 'offline' }); this.clearTimer(); });
    this.socket.on('connect_error', (e: Error) => this.emit({ connection: 'offline', error: e.message || '连接失败，正在重试…' }));
    this.socket.on('revoked', ({ reason }: { reason: string }) => this.revoke(reason));
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
  }
  subscribe(listener: (snapshot: NetworkSnapshot) => void) { this.listeners.add(listener); listener(this.snapshot); return () => { this.listeners.delete(listener); }; }
  connect() { this.socket.connect(); }
  private emit(changes: Partial<NetworkSnapshot>) { this.snapshot = { ...this.snapshot, ...changes }; this.listeners.forEach(fn => fn(this.snapshot)); }
  private clearTimer() { if(this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; }
  private revoke(reason: string) { this.emit({ connection: 'revoked', error: reason || '此座位已在其他页面或设备打开。' }); this.clearTimer(); this.command = null; try { sessionStorage.removeItem(this.key); } catch { /* unavailable */ } this.emit({ pending: false }); this.socket.disconnect(); }
  async execute(input: RoomCommandInput) {
    if(this.snapshot.connection !== 'connected') throw new Error('请等待连接恢复后再操作。');
    if(this.command) throw new Error('上一项操作仍在等待服务器确认。');
    this.command = { ...input, id: crypto.randomUUID(), protocolVersion: PROTOCOL_VERSION, roomCode: this.code };
    try { sessionStorage.setItem(this.key, JSON.stringify(this.command)); } catch { /* ID remains in memory */ }
    this.emit({ pending: true, error: '' }); this.flush();
  }
  private flush() {
    if(!this.command || !this.socket.connected || this.disposed) return;
    const sent = this.command;
    this.clearTimer(); this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flush(); }, 5000);
    this.socket.emit('command', sent, (ack: CommandAck) => {
      if(this.command?.id !== sent.id || this.disposed) return;
      this.clearTimer(); this.command = null;
      try { sessionStorage.removeItem(this.key); } catch { /* unavailable */ }
      this.emit({ pending: false, error: ack.ok ? '' : ack.error }); this.socket.emit('sync');
    });
  }
  dispose() { this.disposed = true; this.clearTimer(); this.socket.disconnect(); this.listeners.clear(); window.removeEventListener('offline', this.offline); window.removeEventListener('online', this.online); }
}
