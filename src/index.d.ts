/**
 * webrtc-rooms — TypeScript type definitions
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'events';
import { Server as HttpServer } from 'http';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Peer state
// ---------------------------------------------------------------------------

/** All possible lifecycle states for a {@link Peer}. */
export type PeerStateValue = 'connecting' | 'joined' | 'reconnecting' | 'closed';

export declare const PeerState: {
  readonly CONNECTING:   'connecting';
  readonly JOINED:       'joined';
  readonly RECONNECTING: 'reconnecting';
  readonly CLOSED:       'closed';
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Allowed primitive values inside a metadata map. */
export type MetadataValue = string | number | boolean | null;

/** Flat key/value store used for both peer and room metadata. */
export type MetadataMap = Record<string, MetadataValue>;

// ---------------------------------------------------------------------------
// WebRTC shape aliases
//
// These describe the plain JSON objects that flow over the wire.
// Defined here rather than importing from lib.dom so this package compiles
// without DOM types in the consumer's TypeScript project.
// ---------------------------------------------------------------------------

/** Plain object shape of an SDP offer or answer as sent over the wire. */
export interface RTCSessionDescriptionInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** Plain object shape of an ICE candidate as sent over the wire. */
export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// ---------------------------------------------------------------------------
// Wire protocol — server → client
// ---------------------------------------------------------------------------

export interface ConnectedMessage        { type: 'connected';        peerId: string }
export interface RoomJoinedMessage       { type: 'room:joined';      roomId: string; peerId: string; peers: PeerSnapshot[]; metadata: MetadataMap; reconnectToken?: string }
export interface RoomStateMessage        { type: 'room:state';       roomId: string; peers: PeerSnapshot[]; metadata: MetadataMap }
export interface RoomUpdatedMessage      { type: 'room:updated';     patch: MetadataMap }
export interface PeerJoinedMessage       { type: 'peer:joined';      peer: PeerSnapshot }
export interface PeerLeftMessage         { type: 'peer:left';        peerId: string }
export interface PeerUpdatedMessage      { type: 'peer:updated';     peerId: string; patch: MetadataMap }
export interface PeerReconnectedMessage  { type: 'peer:reconnected'; peer: PeerSnapshot }
export interface MetadataUpdatedMessage  { type: 'metadata:updated'; metadata: MetadataMap }
export interface OfferMessage            { type: 'offer';            from: string; sdp: RTCSessionDescriptionInit }
export interface AnswerMessage           { type: 'answer';           from: string; sdp: RTCSessionDescriptionInit }
export interface IceCandidateMessage     { type: 'ice-candidate';    from: string; candidate: RTCIceCandidateInit }
export interface DataMessage             { type: 'data';             from: string; payload: unknown }
export interface KickedMessage           { type: 'kicked';           reason: string }
export interface ErrorMessage            { type: 'error';            code: string; message?: string; key?: string }
export interface SfuTransportCreated     { type: 'sfu:transport:created'; routerRtpCapabilities: unknown; sendTransport: unknown; recvTransport: unknown }
export interface SfuProduced             { type: 'sfu:produced';     producerId: string }
export interface SfuConsume              { type: 'sfu:consume';      consumerId: string; producerId: string; kind: string; rtpParameters: unknown }
export interface SfuNewProducer          { type: 'sfu:new-producer'; peerId: string; producerId: string; kind: string }
export interface SfuTransportConnected   { type: 'sfu:transport:connected'; direction: 'send' | 'recv' }

export type ServerMessage =
  | ConnectedMessage | RoomJoinedMessage | RoomStateMessage | RoomUpdatedMessage
  | PeerJoinedMessage | PeerLeftMessage | PeerUpdatedMessage | PeerReconnectedMessage
  | MetadataUpdatedMessage | OfferMessage | AnswerMessage | IceCandidateMessage
  | DataMessage | KickedMessage | ErrorMessage
  | SfuTransportCreated | SfuProduced | SfuConsume | SfuNewProducer | SfuTransportConnected;

// ---------------------------------------------------------------------------
// Wire protocol — client → server
// ---------------------------------------------------------------------------

export interface JoinSignal         { type: 'join';           roomId: string; metadata?: MetadataMap }
export interface ReconnectSignal    { type: 'reconnect';      token: string; roomId: string }
export interface OfferSignal        { type: 'offer';          target: string; sdp: RTCSessionDescriptionInit }
export interface AnswerSignal       { type: 'answer';         target: string; sdp: RTCSessionDescriptionInit }
export interface IceCandidateSignal { type: 'ice-candidate';  target: string; candidate: RTCIceCandidateInit }
export interface DataSignal         { type: 'data';           payload: unknown; target?: string }
export interface MetadataSignal     { type: 'metadata';       patch: MetadataMap }
export interface LeaveSignal        { type: 'leave' }

export type ClientSignal =
  | JoinSignal | ReconnectSignal | OfferSignal | AnswerSignal
  | IceCandidateSignal | DataSignal | MetadataSignal | LeaveSignal;

// ---------------------------------------------------------------------------
// PeerSnapshot — safe serialised form sent over the wire
// ---------------------------------------------------------------------------

export interface PeerSnapshot {
  id:       string;
  roomId:   string | null;
  state:    PeerStateValue;
  metadata: MetadataMap;
}

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export interface PeerOptions {
  id:            string;
  socket:        WebSocket;
  roomId?:       string | null;
  metadata?:     MetadataMap;
  reconnectTtl?: number;
}

export interface PeerEventMap {
  signal:      [data: ClientSignal];
  disconnect:  [];
  reconnected: [];
  error:       [err: Error];
}

export declare class Peer extends EventEmitter {
  /** Static state constants, e.g. `Peer.State.JOINED`. */
  static readonly State: typeof PeerState;

  readonly id:             string;
  socket:                  WebSocket;
  roomId:                  string | null;
  state:                   PeerStateValue;
  metadata:                MetadataMap;
  readonly connectedAt:    number;
  reconnectToken:          string | null;

  /** `true` when the peer is in the `JOINED` state. */
  readonly isActive: boolean;

  constructor(options: PeerOptions);

  send(msg: ServerMessage | Record<string, unknown>): void;
  replaceSocket(newSocket: WebSocket): void;
  setMetadata(patch: MetadataMap): MetadataMap;
  close(code?: number, reason?: string): void;
  toJSON(): PeerSnapshot;

  on<K extends keyof PeerEventMap>(event: K, listener: (...args: PeerEventMap[K]) => void): this;
  emit<K extends keyof PeerEventMap>(event: K, ...args: PeerEventMap[K]): boolean;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export interface RoomOptions {
  id:        string;
  maxPeers?: number;
  metadata?: MetadataMap;
}

export interface RoomSnapshot {
  id:        string;
  metadata:  MetadataMap;
  peers:     PeerSnapshot[];
  createdAt: number;
}

export interface RoomEventMap {
  'peer:joined':     [peer: Peer];
  'peer:left':       [peer: Peer];
  'peer:updated':    [peer: Peer, patch: MetadataMap];
  'peer:reconnected':[peer: Peer];
  'data':            [from: Peer, to: string | null, payload: unknown];
  'offer':           [from: Peer, to: string, sdp: RTCSessionDescriptionInit];
  'answer':          [from: Peer, to: string, sdp: RTCSessionDescriptionInit];
  'ice-candidate':   [from: Peer, to: string, candidate: RTCIceCandidateInit];
}

export declare class Room extends EventEmitter {
  readonly id:        string;
  readonly maxPeers:  number;
  metadata:           MetadataMap;
  readonly peers:     Map<string, Peer>;
  readonly createdAt: number;
  readonly size:      number;
  readonly isEmpty:   boolean;

  constructor(options: RoomOptions);

  addPeer(peer: Peer): boolean;
  resumePeer(peer: Peer, newSocket: WebSocket): void;
  removePeer(peerId: string): void;
  broadcast(msg: Record<string, unknown>, options?: { exclude?: string | string[] }): void;
  setMetadata(patch: MetadataMap): void;
  getState(): RoomSnapshot;
  toJSON(): { id: string; peerCount: number; createdAt: number; metadata: MetadataMap };

  on<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): this;
  emit<K extends keyof RoomEventMap>(event: K, ...args: RoomEventMap[K]): boolean;
}

// ---------------------------------------------------------------------------
// SignalingServer
// ---------------------------------------------------------------------------

/**
 * Async hook called before a peer is admitted to a room.
 *
 * @param peer   - The peer attempting to join. `peer.metadata` is already
 *                 populated from the `join` message.
 * @param roomId - The target room ID.
 * @returns `true` (or any truthy value) to allow, `false` to reject silently,
 *          or a `string` to reject with a human-readable reason.
 */
export type BeforeJoinHook = (
  peer: Peer,
  roomId: string,
) => boolean | string | Promise<boolean | string>;

export interface SignalingServerOptions {
  port?:             number;
  server?:           HttpServer;
  maxPeersPerRoom?:  number;
  autoCreateRooms?:  boolean;
  autoDestroyRooms?: boolean;
  pingInterval?:     number;
  reconnectTtl?:     number;
  beforeJoin?:       BeforeJoinHook;
}

export interface ServerStats {
  rooms:    number;
  peers:    number;
  roomList: ReturnType<Room['toJSON']>[];
}

export interface SignalingServerEventMap {
  listening:          [address: { port: number }];
  'room:created':     [room: Room];
  'room:destroyed':   [room: Room];
  'peer:connected':   [peer: Peer];
  'peer:joined':      [peer: Peer, room: Room];
  'peer:left':        [peer: Peer, room: Room];
  'peer:reconnected': [peer: Peer, room: Room];
  'join:rejected':    [peer: Peer, reason: string];
}

export declare class SignalingServer extends EventEmitter {
  readonly rooms: Map<string, Room>;
  readonly peers: Map<string, Peer>;
  beforeJoin:     BeforeJoinHook | null;

  constructor(options?: SignalingServerOptions);

  createRoom(roomId?: string, options?: { metadata?: MetadataMap }): Room;
  getRoom(roomId: string): Room | undefined;
  kick(peerId: string, reason?: string): void;
  stats(): ServerStats;
  close(): Promise<void>;

  on<K extends keyof SignalingServerEventMap>(
    event: K,
    listener: (...args: SignalingServerEventMap[K]) => void,
  ): this;
  emit<K extends keyof SignalingServerEventMap>(
    event: K,
    ...args: SignalingServerEventMap[K]
  ): boolean;
}

// ---------------------------------------------------------------------------
// AdminAPI
// ---------------------------------------------------------------------------

export interface AdminAPIOptions {
  server:        SignalingServer;
  adminSecret?:  string;
  prefix?:       string;
}

export declare class AdminAPI {
  constructor(options: AdminAPIOptions);
  listen(port?: number): import('http').Server;
  close(): Promise<void>;
  router(): (req: import('http').IncomingMessage, res: import('http').ServerResponse, next?: () => void) => void;
}

// ---------------------------------------------------------------------------
// RecordingAdapter
// ---------------------------------------------------------------------------

export interface RecordingAdapterOptions {
  outputDir:     string;
  format?:       'webm' | 'mp4';
  videoKbps?:    number;
  audioKbps?:    number;
  ffmpegArgs?:   Record<string, string | number>;
}

export interface RecordingInfo {
  path:       string;
  durationMs: number;
}

export interface ActiveRecordingInfo {
  peerId:     string;
  roomId:     string;
  filePath:   string;
  durationMs: number;
}

export declare class RecordingAdapter extends EventEmitter {
  constructor(options: RecordingAdapterOptions);

  attach(server: SignalingServer): this;

  startPeer(peerId: string, roomId?: string): Promise<{ path: string }>;
  stopPeer(peerId: string): Promise<RecordingInfo>;

  startRoom(roomId: string): Promise<{ started: string[] }>;
  stopRoom(roomId: string): Promise<RecordingInfo[]>;

  activeRecordings(): ActiveRecordingInfo[];

  on(event: 'recording:started',      listener: (info: { peerId: string; roomId: string; path: string }) => void): this;
  on(event: 'recording:stopped',      listener: (info: { peerId: string; roomId: string } & RecordingInfo) => void): this;
  on(event: 'recording:error',        listener: (info: { peerId: string; roomId: string; error: Error }) => void): this;
  on(event: 'recording:progress',     listener: (info: { peerId: string; roomId: string; line: string }) => void): this;
  on(event: 'recording:room:started', listener: (info: { roomId: string; peers: string[] }) => void): this;
  on(event: 'recording:room:stopped', listener: (info: { roomId: string; files: RecordingInfo[] }) => void): this;
}

// ---------------------------------------------------------------------------
// MediasoupAdapter
// ---------------------------------------------------------------------------

export interface MediasoupAdapterOptions {
  listenIp?:    string;
  announcedIp?: string | null;
  rtcMinPort?:  number;
  rtcMaxPort?:  number;
  numWorkers?:  number;
}

export interface SfuRoomStats {
  roomId:     string;
  transports: number;
  producers:  number;
  consumers:  number;
}

export declare class MediasoupAdapter extends EventEmitter {
  constructor(options?: MediasoupAdapterOptions);

  init(): Promise<void>;
  close(): Promise<void>;
  attach(server: SignalingServer): this;
  stats(): { workers: number; rooms: SfuRoomStats[] };
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  maxConnPerMin?:  number;
  maxMsgPerSec?:   number;
  maxMsgPerMin?:   number;
  banDurationMs?:  number;
  whitelist?:      string[];
}

export interface BanInfo {
  ip:        string;
  expiresIn: number;
}

export declare class RateLimiter extends EventEmitter {
  readonly whitelist: Set<string>;

  constructor(options?: RateLimiterOptions);

  attach(server: SignalingServer): this;
  ban(ip: string, durationMs?: number): void;
  unban(ip: string): void;
  bans(): BanInfo[];
  destroy(): void;

  on(event: 'connection:blocked', listener: (info: { ip: string }) => void): this;
  on(event: 'signal:blocked',     listener: (info: { peerId: string }) => void): this;
  on(event: 'ip:banned',          listener: (info: { ip: string; until: number }) => void): this;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new {@link SignalingServer}.
 *
 * @example
 * import { createServer } from 'webrtc-rooms';
 * const server = createServer({ port: 3000 });
 */
export declare function createServer(options?: SignalingServerOptions): SignalingServer;

// ---------------------------------------------------------------------------
// RedisAdapter
// ---------------------------------------------------------------------------

export interface RedisAdapterOptions {
  pub:        object;
  sub:        object;
  server:     SignalingServer;
  channel?:   string;
  keyPrefix?: string;
  peerTtl?:   number;
}

export interface RemotePeerDetail {
  peerId:    string;
  processId: string;
  joinedAt:  number;
}

export declare class RedisAdapter extends EventEmitter {
  constructor(options: RedisAdapterOptions);

  init(): Promise<void>;
  close(): Promise<void>;

  getRoomPeers(roomId: string): Promise<string[]>;
  getActiveRooms(): Promise<string[]>;
  getRoomPeerDetails(roomId: string): Promise<RemotePeerDetail[]>;

  on(event: 'message:published', listener: (payload: object) => void): this;
  on(event: 'message:received',  listener: (envelope: object) => void): this;
  on(event: 'remote:peer:joined', listener: (envelope: object) => void): this;
  on(event: 'remote:peer:left',   listener: (envelope: object) => void): this;
  on(event: 'error',              listener: (err: Error) => void): this;
}

// ---------------------------------------------------------------------------
// RoomPersistence
// ---------------------------------------------------------------------------

export interface RoomPersistenceOptions {
  redis:         object;
  server:        SignalingServer;
  keyPrefix?:    string;
  indexKey?:     string;
  snapshotTtl?:  number;
}

/**
 * Shape of a room snapshot as stored in and returned from Redis.
 * Distinct from {@link RoomSnapshot} (which is the live room state shape
 * returned by `Room.getState()`) because it includes persistence-specific
 * fields (`maxPeers`, `savedAt`) and uses `roomId` as the key field.
 */
export interface PersistedRoomSnapshot {
  roomId:    string;
  metadata:  MetadataMap;
  maxPeers:  number;
  createdAt: number;
  savedAt:   number;
}

export interface RestoreResult {
  restored: string[];
  skipped:  string[];
}

export declare class RoomPersistence extends EventEmitter {
  constructor(options: RoomPersistenceOptions);

  restore(): Promise<RestoreResult>;
  attach(): this;
  saveRoom(roomId: string): Promise<void>;
  deleteSnapshot(roomId: string): Promise<void>;
  listSnapshots(): Promise<PersistedRoomSnapshot[]>;

  on(event: 'room:saved',        listener: (info: { roomId: string; key: string }) => void): this;
  on(event: 'room:deleted',      listener: (info: { roomId: string }) => void): this;
  on(event: 'restore:complete',  listener: (result: RestoreResult) => void): this;
}

// ---------------------------------------------------------------------------
// E2EKeyExchange
// ---------------------------------------------------------------------------

export interface E2EKeyExchangeOptions {
  server:                       SignalingServer;
  requireKeyOnJoin?:            boolean;
  keyAnnouncementTimeoutMs?:    number;
  allowedCurves?:               string[];
}

export interface PublicKeyEntry {
  publicKey:   string;
  curve:       string;
  announcedAt: number;
  version:     number;
}

export interface RoomKeyEntry extends PublicKeyEntry {
  peerId: string;
}

export interface E2EStats {
  roomId:    string;
  peerCount: number;
}

export declare class E2EKeyExchange extends EventEmitter {
  constructor(options: E2EKeyExchangeOptions);

  attach(): this;

  getPeerKey(roomId: string, peerId: string): PublicKeyEntry | undefined;
  getRoomKeys(roomId: string): RoomKeyEntry[];
  stats(): E2EStats[];

  on(event: 'key:announced', listener: (info: { peerId: string; roomId: string; publicKey: string; curve: string }) => void): this;
  on(event: 'key:rotated',   listener: (info: { peerId: string; roomId: string; publicKey: string; curve: string; version: number }) => void): this;
  on(event: 'key:revoked',   listener: (info: { peerId: string; roomId: string; entry: PublicKeyEntry }) => void): this;
}