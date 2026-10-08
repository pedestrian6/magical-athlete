import type { ActionInput } from '../game/types';
import type { PublicGameView } from '../game/public';

export const PROTOCOL_VERSION = 1 as const;
export type RoomStatus = 'lobby' | 'playing' | 'finished' | 'closed';
export interface SeatView {
  id: string;
  name: string;
  playerId: number | null;
  ready: boolean;
  online: boolean;
}
export interface RoomView {
  protocolVersion: 1;
  code: string;
  status: RoomStatus;
  revision: number;
  viewerSeatId: string;
  hostSeatId: string;
  capacity: number;
  duo: boolean;
  seats: SeatView[];
  game: PublicGameView | null;
  expiresAt: number;
  serverTime: number;
}
export interface RoomSummary { code: string; status: RoomStatus; name: string; expiresAt: number }
export type RoomCommandInput =
  | { type: 'ready'; ready: boolean }
  | { type: 'configure'; capacity: number; duo: boolean }
  | { type: 'kick'; seatId: string }
  | { type: 'leave' }
  | { type: 'start' }
  | { type: 'close' }
  | { type: 'game'; gameId: string; revision: number; race: number; action: ActionInput };
export type RoomCommand = RoomCommandInput & { id: string; protocolVersion: 1; roomCode: string };
export type CommandAck = { ok: true; revision: number } | { ok: false; error: string; code: string };
export interface SeatAccess { code: string; recoveryCode: string }
export interface ApiError { error: string; code: string }
