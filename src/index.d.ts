/**
 * webrtc-rooms — TypeScript type definitions
 *
 * @packageDocumentation
 */

import { EventEmitter } from "events";
import { Server as HttpServer } from "http";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Minimal WebRTC shared types (for Node-only TypeScript projects)
// ---------------------------------------------------------------------------

export type RTCSdpType = "offer" | "pranswer" | "answer" | "rollback";

export interface RTCSessionDescriptionInit {
  type?: RTCSdpType;
  sdp?: string;
}

export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// ---------------------------------------------------------------------------
// Peer state
// ---------------------------------------------------------------------------

/** All possible lifecycle states for a {@link Peer}. */
export type PeerStateValue =
  | "connecting"
  | "joined"
  | "reconnecting"
  | "closed";

export declare const PeerState: {
  readonly CONNECTING: "connecting";
  readonly JOINED: "joined";
  readonly RECONNECTING: "reconnecting";
  readonly CLOSED: "closed";
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Allowed primitive values inside a metadata map. */
export type MetadataValue = string | number | boolean | null;

/** Flat key/value store used for both peer and room metadata. */
export type MetadataMap = Record<string, MetadataValue>;

// ---------------------------------------------------------------------------
// Wire protocol — server → client
// ---------------------------------------------------------------------------

export interface ConnectedMessage {
  type: "connected";
  peerId: string;
}
export interface RoomJoinedMessage {
  type: "room:joined";
  roomId: string;
  peerId: string;
  peers: PeerSnapshot[];
  metadata: MetadataMap;
  reconnectToken?: string;
}
export interface RoomStateMessage {
  type: "room:state";
  roomId: string;
  peers: PeerSnapshot[];
  metadata: MetadataMap;
}
export interface RoomUpdatedMessage {
  type: "room:updated";
  patch: MetadataMap;
}
export interface PeerJoinedMessage {
  type: "peer:joined";
  peer: PeerSnapshot;
}
export interface PeerLeftMessage {
  type: "peer:left";
  peerId: string;
}
export interface PeerUpdatedMessage {
  type: "peer:updated";
  peerId: string;
  patch: MetadataMap;
}
export interface PeerReconnectedMessage {
  type: "peer:reconnected";
  peer: PeerSnapshot;
}
export interface MetadataUpdatedMessage {
  type: "metadata:updated";
  metadata: MetadataMap;
}
export interface OfferMessage {
  type: "offer";
  from: string;
  sdp: RTCSessionDescriptionInit;
}
export interface AnswerMessage {
  type: "answer";
  from: string;
  sdp: RTCSessionDescriptionInit;
}
export interface IceCandidateMessage {
  type: "ice-candidate";
  from: string;
  candidate: RTCIceCandidateInit;
}
export interface DataMessage {
  type: "data";
  from: string;
  payload: unknown;
}
export interface KickedMessage {
  type: "kicked";
  reason: string;
}
export interface ErrorMessage {
  type: "error";
  code: string;
  message?: string;
  key?: string;
}
export interface SfuTransportCreated {
  type: "sfu:transport:created";
  routerRtpCapabilities: unknown;
  sendTransport: unknown;
  recvTransport: unknown;
}
export interface SfuProduced {
  type: "sfu:produced";
  producerId: string;
}
export interface SfuConsume {
  type: "sfu:consume";
  consumerId: string;
  producerId: string;
  kind: string;
  rtpParameters: unknown;
}
export interface SfuNewProducer {
  type: "sfu:new-producer";
  peerId: string;
  producerId: string;
  kind: string;
}
export interface SfuTransportConnected {
  type: "sfu:transport:connected";
  direction: "send" | "recv";
}

export type ServerMessage =
  | ConnectedMessage
  | RoomJoinedMessage
  | RoomStateMessage
  | RoomUpdatedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PeerUpdatedMessage
  | PeerReconnectedMessage
  | MetadataUpdatedMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | DataMessage
  | KickedMessage
  | ErrorMessage
  | SfuTransportCreated
  | SfuProduced
  | SfuConsume
  | SfuNewProducer
  | SfuTransportConnected;

// ---------------------------------------------------------------------------
// Wire protocol — client → server
// ---------------------------------------------------------------------------

export interface JoinSignal {
  type: "join";
  roomId: string;
  metadata?: MetadataMap;
}
export interface ReconnectSignal {
  type: "reconnect";
  token: string;
  roomId: string;
}
export interface OfferSignal {
  type: "offer";
  target: string;
  sdp: RTCSessionDescriptionInit;
}
export interface AnswerSignal {
  type: "answer";
  target: string;
  sdp: RTCSessionDescriptionInit;
}
export interface IceCandidateSignal {
  type: "ice-candidate";
  target: string;
  candidate: RTCIceCandidateInit;
}
export interface DataSignal {
  type: "data";
  payload: unknown;
  target?: string;
}
export interface MetadataSignal {
  type: "metadata";
  patch: MetadataMap;
}
export interface LeaveSignal {
  type: "leave";
}

export type ClientSignal =
  | JoinSignal
  | ReconnectSignal
  | OfferSignal
  | AnswerSignal
  | IceCandidateSignal
  | DataSignal
  | MetadataSignal
  | LeaveSignal;

// ---------------------------------------------------------------------------
// PeerSnapshot — safe serialised form sent over the wire
// ---------------------------------------------------------------------------

export interface PeerSnapshot {
  id: string;
  roomId: string | null;
  state: PeerStateValue;
  metadata: MetadataMap;
}

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export interface PeerOptions {
  id: string;
  socket: WebSocket;
  roomId?: string | null;
  metadata?: MetadataMap;
  reconnectTtl?: number;
}

export interface PeerEventMap {
  signal: [data: ClientSignal];
  disconnect: [];
  reconnected: [];
  error: [err: Error];
}

export declare class Peer extends EventEmitter {
  /** Static state constants, e.g. `Peer.State.JOINED`. */
  static readonly State: typeof PeerState;

  readonly id: string;
  socket: WebSocket;
  roomId: string | null;
  state: PeerStateValue;
  metadata: MetadataMap;
  readonly connectedAt: number;
  reconnectToken: string | null;

  /** `true` when the peer is in the `JOINED` state. */
  readonly isActive: boolean;

  constructor(options: PeerOptions);

  send(msg: ServerMessage | Record<string, unknown>): void;
  replaceSocket(newSocket: WebSocket): void;
  setMetadata(patch: MetadataMap): MetadataMap;
  close(code?: number, reason?: string): void;
  toJSON(): PeerSnapshot;

  on<K extends keyof PeerEventMap>(
    event: K,
    listener: (...args: PeerEventMap[K]) => void,
  ): this;
  emit<K extends keyof PeerEventMap>(
    event: K,
    ...args: PeerEventMap[K]
  ): boolean;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export interface RoomOptions {
  id: string;
  maxPeers?: number;
  metadata?: MetadataMap;
}

export interface RoomSnapshot {
  id: string;
  metadata: MetadataMap;
  peers: PeerSnapshot[];
  createdAt: number;
}

export interface RoomEventMap {
  "peer:joined": [peer: Peer];
  "peer:left": [peer: Peer];
  "peer:updated": [peer: Peer, patch: MetadataMap];
  "peer:reconnected": [peer: Peer];
  data: [from: Peer, to: string | null, payload: unknown];
  offer: [from: Peer, to: string, sdp: RTCSessionDescriptionInit];
  answer: [from: Peer, to: string, sdp: RTCSessionDescriptionInit];
  "ice-candidate": [from: Peer, to: string, candidate: RTCIceCandidateInit];
}

export declare class Room extends EventEmitter {
  readonly id: string;
  readonly maxPeers: number;
  metadata: MetadataMap;
  readonly peers: Map<string, Peer>;
  readonly createdAt: number;
  readonly size: number;
  readonly isEmpty: boolean;

  constructor(options: RoomOptions);

  addPeer(peer: Peer): boolean;
  resumePeer(peer: Peer, newSocket: WebSocket): void;
  removePeer(peerId: string): void;
  broadcast(
    msg: Record<string, unknown>,
    options?: { exclude?: string | string[] },
  ): void;
  setMetadata(patch: MetadataMap): void;
  getState(): RoomSnapshot;
  toJSON(): {
    id: string;
    peerCount: number;
    createdAt: number;
    metadata: MetadataMap;
  };

  on<K extends keyof RoomEventMap>(
    event: K,
    listener: (...args: RoomEventMap[K]) => void,
  ): this;
  emit<K extends keyof RoomEventMap>(
    event: K,
    ...args: RoomEventMap[K]
  ): boolean;
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
  port?: number;
  server?: HttpServer;
  maxPeersPerRoom?: number;
  autoCreateRooms?: boolean;
  autoDestroyRooms?: boolean;
  pingInterval?: number;
  reconnectTtl?: number;
  beforeJoin?: BeforeJoinHook;
}

export interface ServerStats {
  rooms: number;
  peers: number;
  roomList: ReturnType<Room["toJSON"]>[];
}

export interface SignalingServerEventMap {
  listening: [address: { port: number }];
  "room:created": [room: Room];
  "room:destroyed": [room: Room];
  "peer:connected": [peer: Peer];
  "peer:joined": [peer: Peer, room: Room];
  "peer:left": [peer: Peer, room: Room];
  "peer:reconnected": [peer: Peer, room: Room];
  "join:rejected": [peer: Peer, reason: string];
}

export declare class SignalingServer extends EventEmitter {
  readonly rooms: Map<string, Room>;
  readonly peers: Map<string, Peer>;
  beforeJoin: BeforeJoinHook | null;

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
  server: SignalingServer;
  adminSecret?: string;
  prefix?: string;
}

export declare class AdminAPI {
  constructor(options: AdminAPIOptions);
  listen(port?: number): import("http").Server;
  close(): Promise<void>;
  router(): (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    next?: () => void,
  ) => void;
}

// ---------------------------------------------------------------------------
// RecordingAdapter
// ---------------------------------------------------------------------------

export interface RecordingAdapterOptions {
  outputDir: string;
  format?: "webm" | "mp4";
  videoKbps?: number;
  audioKbps?: number;
  ffmpegArgs?: Record<string, string | number>;
}

export interface RecordingInfo {
  path: string;
  durationMs: number;
}

export interface ActiveRecordingInfo {
  peerId: string;
  roomId: string;
  filePath: string;
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

  on(
    event: "recording:started",
    listener: (info: { peerId: string; roomId: string; path: string }) => void,
  ): this;
  on(
    event: "recording:stopped",
    listener: (
      info: { peerId: string; roomId: string } & RecordingInfo,
    ) => void,
  ): this;
  on(
    event: "recording:error",
    listener: (info: { peerId: string; roomId: string; error: Error }) => void,
  ): this;
  on(
    event: "recording:progress",
    listener: (info: { peerId: string; roomId: string; line: string }) => void,
  ): this;
  on(
    event: "recording:room:started",
    listener: (info: { roomId: string; peers: string[] }) => void,
  ): this;
  on(
    event: "recording:room:stopped",
    listener: (info: { roomId: string; files: RecordingInfo[] }) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// MediasoupAdapter
// ---------------------------------------------------------------------------

export interface MediasoupAdapterOptions {
  listenIp?: string;
  announcedIp?: string | null;
  rtcMinPort?: number;
  rtcMaxPort?: number;
  numWorkers?: number;
}

export interface SfuRoomStats {
  roomId: string;
  transports: number;
  producers: number;
  consumers: number;
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
  maxConnPerMin?: number;
  maxMsgPerSec?: number;
  maxMsgPerMin?: number;
  banDurationMs?: number;
  whitelist?: string[];
}

export interface BanInfo {
  ip: string;
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

  on(
    event: "connection:blocked",
    listener: (info: { ip: string }) => void,
  ): this;
  on(
    event: "signal:blocked",
    listener: (info: { peerId: string }) => void,
  ): this;
  on(
    event: "ip:banned",
    listener: (info: { ip: string; until: number }) => void,
  ): this;
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
export declare function createServer(
  options?: SignalingServerOptions,
): SignalingServer;

// ---------------------------------------------------------------------------
// RedisAdapter
// ---------------------------------------------------------------------------

export interface RedisAdapterOptions {
  pub: object;
  sub: object;
  server: SignalingServer;
  channel?: string;
  keyPrefix?: string;
  peerTtl?: number;
}

export interface RemotePeerDetail {
  peerId: string;
  processId: string;
  joinedAt: number;
}

export declare class RedisAdapter extends EventEmitter {
  constructor(options: RedisAdapterOptions);

  init(): Promise<void>;
  close(): Promise<void>;

  getRoomPeers(roomId: string): Promise<string[]>;
  getActiveRooms(): Promise<string[]>;
  getRoomPeerDetails(roomId: string): Promise<RemotePeerDetail[]>;

  on(event: "message:published", listener: (payload: object) => void): this;
  on(event: "message:received", listener: (envelope: object) => void): this;
  on(event: "remote:peer:joined", listener: (envelope: object) => void): this;
  on(event: "remote:peer:left", listener: (envelope: object) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

// ---------------------------------------------------------------------------
// RoomPersistence
// ---------------------------------------------------------------------------

export interface RoomPersistenceOptions {
  redis: object;
  server: SignalingServer;
  keyPrefix?: string;
  indexKey?: string;
  snapshotTtl?: number;
}

/**
 * Shape of a room snapshot as stored in and returned from Redis.
 * Distinct from {@link RoomSnapshot} (which is the live room state shape
 * returned by `Room.getState()`) because it includes persistence-specific
 * fields (`maxPeers`, `savedAt`) and uses `roomId` as the key field.
 */
export interface PersistedRoomSnapshot {
  roomId: string;
  metadata: MetadataMap;
  maxPeers: number;
  createdAt: number;
  savedAt: number;
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
}

export declare class RoomPersistence extends EventEmitter {
  constructor(options: RoomPersistenceOptions);

  restore(): Promise<RestoreResult>;
  attach(): this;
  saveRoom(roomId: string): Promise<void>;
  deleteSnapshot(roomId: string): Promise<void>;
  listSnapshots(): Promise<PersistedRoomSnapshot[]>;

  on(
    event: "room:saved",
    listener: (info: { roomId: string; key: string }) => void,
  ): this;
  on(event: "room:deleted", listener: (info: { roomId: string }) => void): this;
  on(
    event: "restore:complete",
    listener: (result: RestoreResult) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// E2EKeyExchange
// ---------------------------------------------------------------------------

export interface E2EKeyExchangeOptions {
  server: SignalingServer;
  requireKeyOnJoin?: boolean;
  keyAnnouncementTimeoutMs?: number;
  allowedCurves?: string[];
}

export interface PublicKeyEntry {
  publicKey: string;
  curve: string;
  announcedAt: number;
  version: number;
}

export interface RoomKeyEntry extends PublicKeyEntry {
  peerId: string;
}

export interface E2EStats {
  roomId: string;
  peerCount: number;
}

export declare class E2EKeyExchange extends EventEmitter {
  constructor(options: E2EKeyExchangeOptions);

  attach(): this;

  getPeerKey(roomId: string, peerId: string): PublicKeyEntry | undefined;
  getRoomKeys(roomId: string): RoomKeyEntry[];
  stats(): E2EStats[];

  on(
    event: "key:announced",
    listener: (info: {
      peerId: string;
      roomId: string;
      publicKey: string;
      curve: string;
    }) => void,
  ): this;
  on(
    event: "key:rotated",
    listener: (info: {
      peerId: string;
      roomId: string;
      publicKey: string;
      curve: string;
      version: number;
    }) => void,
  ): this;
  on(
    event: "key:revoked",
    listener: (info: {
      peerId: string;
      roomId: string;
      entry: PublicKeyEntry;
    }) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export type SessionStateValue =
  | "created"
  | "active"
  | "suspended"
  | "resumed"
  | "expired"
  | "migrated";

export interface Session {
  id: string;
  token: string;
  roomId: string;
  metadata: MetadataMap;
  state: SessionStateValue;
  createdAt: number;
  suspendedAt: number;
  ttl: number;
  queue: object[];
  region: string;
}

export interface SessionManagerOptions {
  reconnectTtl?: number;
  maxQueueSize?: number;
  secret?: string;
  redis?: object;
  region?: string;
  cleanupIntervalMs?: number;
}

export declare class SessionManager extends EventEmitter {
  static readonly State: {
    CREATED: "created";
    ACTIVE: "active";
    SUSPENDED: "suspended";
    RESUMED: "resumed";
    EXPIRED: "expired";
    MIGRATED: "migrated";
  };

  constructor(options?: SessionManagerOptions);

  attach(server: SignalingServer): this;
  resume(token: string, roomId: string): Promise<Session | null>;
  enqueue(peerId: string, msg: object): boolean;
  flushQueue(peerId: string, sendFn: (msg: object) => void): number;
  getSession(peerId: string): Session | undefined;
  migrateSession(peerId: string, targetRegion: string): Promise<boolean>;
  stats(): { active: number; suspended: number; total: number };
  close(): Promise<void>;

  on(event: "session:created", listener: (session: Session) => void): this;
  on(
    event: "session:suspended",
    listener: (session: Session, room: Room) => void,
  ): this;
  on(event: "session:resumed", listener: (session: Session) => void): this;
  on(event: "session:expired", listener: (session: Session) => void): this;
  on(
    event: "session:migrated",
    listener: (session: Session, targetRegion: string) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// PolicyEngine
// ---------------------------------------------------------------------------

export type Capability =
  | "publish"
  | "subscribe"
  | "kick"
  | "record"
  | "moderate"
  | "data"
  | "admin";

export interface Policy {
  iss: string;
  sub: string;
  roomId: string;
  role: string;
  caps: Capability[];
  expiresAt: number;
  region?: string;
  maxPeers?: number;
}

export interface PolicyEngineOptions {
  secret: string;
  issuer?: string;
  required?: boolean;
  defaultCaps?: Capability[];
  tokenMetadataKey?: string;
}

export interface PolicyIssueOptions {
  sub: string;
  roomId?: string;
  role?: string;
  caps?: Capability[];
  expiresIn?: number;
  region?: string;
  maxPeers?: number;
}

export declare class PolicyEngine extends EventEmitter {
  constructor(options: PolicyEngineOptions);

  attach(server: SignalingServer): this;
  issue(options: PolicyIssueOptions): string;
  verify(
    token: string,
  ): { valid: true; policy: Policy } | { valid: false; reason: string };
  hasCap(peer: Peer, cap: Capability): boolean;
  getCaps(peer: Peer): Capability[];
  stats(): { required: boolean; issuer: string; defaultCaps: Capability[] };

  on(event: "policy:issued", listener: (policy: Policy) => void): this;
  on(
    event: "policy:verified",
    listener: (policy: Policy, peer: Peer) => void,
  ): this;
  on(
    event: "policy:violation",
    listener: (info: {
      peer: Peer;
      roomId: string;
      code: string;
      reason?: string;
    }) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// NativeSFUEngine
// ---------------------------------------------------------------------------

export interface NativeSFUEngineOptions {
  region?: string;
  maxRoomsPerWorker?: number;
  numWorkers?: number;
  listenIp?: string;
  announcedIp?: string | null;
  rtcMinPort?: number;
  rtcMaxPort?: number;
  enableSimulcast?: boolean;
  enableDtx?: boolean;
}

export interface NativeSFUStats {
  region: string;
  rooms: number;
  totalProducers: number;
  totalConsumers: number;
  totalTransports: number;
  initialized: boolean;
}

export declare class NativeSFUEngine extends EventEmitter {
  constructor(options?: NativeSFUEngineOptions);

  init(): Promise<void>;
  attach(server: SignalingServer): this;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
  stats(): NativeSFUStats;

  on(
    event: "producer:created",
    listener: (producer: object, room: Room) => void,
  ): this;
  on(
    event: "producer:closed",
    listener: (producer: object, room: Room) => void,
  ): this;
  on(
    event: "consumer:created",
    listener: (consumer: object, producer: object, room: Room) => void,
  ): this;
  on(
    event: "consumer:closed",
    listener: (consumer: object, room: Room) => void,
  ): this;
  on(
    event: "layer:changed",
    listener: (consumer: object, layer: string) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// SFUOrchestrator
// ---------------------------------------------------------------------------

export type SFUHealthValue = "healthy" | "degraded" | "down";

export interface SFUOrchestratorOptions {
  server: SignalingServer;
  healthCheckIntervalMs?: number;
  maxRoomsPerSFU?: number;
  defaultRegion?: string;
  fallbackToP2P?: boolean;
}

export interface SFURegionStats {
  region: string;
  health: SFUHealthValue;
  roomCount: number;
  failCount: number;
  initialized: boolean;
  adapterStats: object | null;
}

export declare class SFUOrchestrator extends EventEmitter {
  static readonly Health: {
    HEALTHY: "healthy";
    DEGRADED: "degraded";
    DOWN: "down";
  };

  constructor(options: SFUOrchestratorOptions);

  register(region: string, adapter: object): this;
  init(): Promise<void>;
  close(): Promise<void>;
  getSFUForRoom(roomId: string): object | null;
  migrateRoom(roomId: string, targetRegion: string): Promise<boolean>;
  stats(): SFURegionStats[];
  readonly size: number;

  on(event: "sfu:registered", listener: (region: string) => void): this;
  on(event: "sfu:healthy", listener: (region: string) => void): this;
  on(event: "sfu:degraded", listener: (region: string) => void): this;
  on(event: "sfu:down", listener: (region: string) => void): this;
  on(
    event: "room:assigned",
    listener: (roomId: string, region: string) => void,
  ): this;
  on(
    event: "room:migrated",
    listener: (roomId: string, from: string, to: string) => void,
  ): this;
  on(
    event: "failover",
    listener: (region: string, rooms: string[]) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// AdaptiveBitrateController
// ---------------------------------------------------------------------------

export interface AdaptiveBitrateControllerOptions {
  sfuEngine: NativeSFUEngine;
  upgradeHoldMs?: number;
  decayIntervalMs?: number;
  mobileFirst?: boolean;
  protectActiveSpeaker?: boolean;
  protectScreenShare?: boolean;
}

export interface SubscriberQualityStats {
  consumerId: string;
  peerId: string;
  score: number;
  currentLayer: string;
  targetLayer: string;
  deviceType: string;
  isActiveSpeaker: boolean;
  pliCount: number;
  nackCount: number;
}

export declare class AdaptiveBitrateController extends EventEmitter {
  constructor(options: AdaptiveBitrateControllerOptions);

  attach(server: SignalingServer): this;
  setActiveSpeaker(producerId: string): void;
  clearActiveSpeaker(producerId: string): void;
  markScreenShare(producerId: string): void;
  stats(): SubscriberQualityStats[];
  close(): void;

  on(
    event: "layer:changed",
    listener: (info: {
      consumerId: string;
      peerId: string;
      from: string;
      to: string;
      score: number;
    }) => void,
  ): this;
  on(
    event: "score:updated",
    listener: (info: {
      consumerId: string;
      peerId: string;
      score: number;
    }) => void,
  ): this;
  on(
    event: "audio:only:hint",
    listener: (info: {
      consumerId: string;
      peerId: string;
      score: number;
    }) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// RegionRouter
// ---------------------------------------------------------------------------

export interface RegionRouterOptions {
  server: SignalingServer;
  localRegion: string;
  regions: string[];
  mode?: "latency" | "affinity" | "residency" | "load" | "manual";
  loadFn?: (region: string) => Promise<number>;
  latencyFn?: (ip: string, region: string) => Promise<number>;
  emitMigrationHints?: boolean;
}

export declare class RegionRouter extends EventEmitter {
  constructor(options: RegionRouterOptions);

  attach(): this;
  getPeerRegion(peerId: string): string | undefined;
  getRoomRegion(roomId: string): string | undefined;
  assignRoomRegion(roomId: string, region: string): void;
  stats(): {
    localRegion: string;
    mode: string;
    regions: string[];
    peerRoutes: number;
    roomRoutes: number;
  };

  on(
    event: "peer:routed",
    listener: (info: { peerId: string; region: string }) => void,
  ): this;
  on(
    event: "room:routed",
    listener: (info: { roomId: string; region: string }) => void,
  ): this;
  on(
    event: "peer:should:migrate",
    listener: (info: {
      peerId: string;
      currentRegion: string;
      targetRegion: string;
    }) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// ThreatDetector
// ---------------------------------------------------------------------------

export type ThreatLevelValue = "warn" | "throttle" | "kick" | "ban";

export interface ThreatDetectorOptions {
  server: SignalingServer;
  onThreat?: (info: {
    level: ThreatLevelValue;
    threat: string;
    peer: Peer | null;
    ip: string;
  }) => void;
  thresholds?: Record<string, number>;
  whitelist?: string[];
}

export declare class ThreatDetector extends EventEmitter {
  static readonly Level: {
    WARN: "warn";
    THROTTLE: "throttle";
    KICK: "kick";
    BAN: "ban";
  };

  constructor(options: ThreatDetectorOptions);

  attach(): this;
  isBanned(ip: string): boolean;
  ban(ip: string, durationMs?: number): void;
  unban(ip: string): void;
  bans(): Array<{ ip: string; expiresIn: number }>;
  stats(): { bans: number; trackedPeers: number; whitelist: string[] };
  close(): void;

  on(
    event: "threat",
    listener: (info: {
      level: string;
      threat: string;
      peer: Peer | null;
      ip: string;
      ts: number;
    }) => void,
  ): this;
  on(
    event: "ban",
    listener: (info: { ip: string; until: number }) => void,
  ): this;
  on(event: "unban", listener: (info: { ip: string }) => void): this;
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

export interface MetricsCollectorOptions {
  server: SignalingServer;
  collectRoomMetrics?: boolean;
  collectSystemMetrics?: boolean;
  systemSampleIntervalMs?: number;
  maxSamplesPerHistogram?: number;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

export interface RoomQoSStats {
  roomId: string;
  peersCurrent: number;
  peersPeak: number;
  joinsTotal: number;
  leavesTotal: number;
  reconnectAttempts: number;
  reconnectSuccessRate: number;
  joinLatency: LatencyStats;
  dataMessages: number;
  createdAt: number;
  lastActivityAt: number;
}

export declare class MetricsCollector extends EventEmitter {
  constructor(options: MetricsCollectorOptions);

  attach(): this;
  snapshot(): object;
  roomSnapshot(roomId: string): RoomQoSStats | null;
  allRoomSnapshots(): RoomQoSStats[];
  toPrometheus(): string;
  recordReconnectAttempt(peerId: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface TracerOptions {
  server: SignalingServer;
  exporter?: (span: object) => Promise<void>;
  mode?: "console" | "buffer" | "noop";
  bufferSize?: number;
  serviceName?: string;
}

export interface SpanHandle {
  spanId: string;
  addEvent: (name: string, attrs?: object) => void;
  end: (status?: "ok" | "error", error?: string) => void;
}

export declare class Tracer extends EventEmitter {
  constructor(options: TracerOptions);

  attach(): this;
  startSpan(
    name: string,
    parentTraceId?: string | null,
    attrs?: object,
  ): SpanHandle;
  getSpans(options?: {
    limit?: number;
    name?: string;
    traceId?: string;
  }): object[];
  getTraceId(peerId: string): string | undefined;
  stats(): { activeSpans: number; buffered: number; activePeerTraces: number };

  on(event: "span:finished", listener: (span: object) => void): this;
}

// ---------------------------------------------------------------------------
// AlertManager
// ---------------------------------------------------------------------------

export interface AlertManagerOptions {
  channels?: Array<{
    type: "console" | "webhook" | "custom";
    url?: string;
    handler?: Function;
  }>;
  suppressionWindowMs?: number;
}

export declare class AlertManager extends EventEmitter {
  constructor(options?: AlertManagerOptions);

  attachHealthMonitor(healthMonitor: HealthMonitor): this;
  attachThreatDetector(threatDetector: ThreatDetector): this;
  attachSFUOrchestrator(orchestrator: SFUOrchestrator): this;
  attachBackpressure(bp: BackpressureController): this;
  alert(options: {
    event: string;
    severity: string;
    message: string;
    context?: object;
    recovered?: boolean;
  }): void;
  recent(limit?: number): object[];
  clearSuppression(): void;
}

// ---------------------------------------------------------------------------
// HealthMonitor
// ---------------------------------------------------------------------------

export interface HealthMonitorOptions {
  server: SignalingServer;
  metrics: MetricsCollector;
  slos?: object[];
  checkIntervalMs?: number;
}

export declare class HealthMonitor extends EventEmitter {
  constructor(options: HealthMonitorOptions);

  attach(): this;
  report(): object;
  isHealthy(): boolean;
  breaches(): object[];
  close(): void;

  on(event: "slo:breach", listener: (breach: object) => void): this;
  on(event: "slo:recovered", listener: (breach: object) => void): this;
}

// ---------------------------------------------------------------------------
// EventReplay
// ---------------------------------------------------------------------------

export interface EventReplayOptions {
  server: SignalingServer;
  maxEventsPerRoom?: number;
  replayTtlMs?: number;
  replayOnReconnect?: boolean;
}

export declare class EventReplay extends EventEmitter {
  constructor(options: EventReplayOptions);

  attach(): this;
  record(
    type: string,
    roomId: string,
    peerId: string | null,
    payload?: object,
  ): object | null;
  since(afterSeq: number): object[];
  roomEvents(roomId: string, afterSeq?: number): object[];
  replayToPeer(peerId: string, afterSeq?: number): number;
  stats(): object[];

  on(
    event: "replayed",
    listener: (info: { peerId: string; roomId: string; count: number }) => void,
  ): this;
  on(event: "gap:detected", listener: (info: object) => void): this;
}

// ---------------------------------------------------------------------------
// BackpressureController
// ---------------------------------------------------------------------------

export type LoadLevelValue =
  | "normal"
  | "elevated"
  | "high"
  | "critical"
  | "shedding";

export interface BackpressureControllerOptions {
  server: SignalingServer;
  maxPeers?: number;
  sampleIntervalMs?: number;
  enableLoadShedding?: boolean;
  joinSlowdownMs?: number;
}

export declare class BackpressureController extends EventEmitter {
  static readonly Level: {
    NORMAL: "normal";
    ELEVATED: "elevated";
    HIGH: "high";
    CRITICAL: "critical";
    SHEDDING: "shedding";
  };

  constructor(options: BackpressureControllerOptions);

  attach(): this;
  status(): {
    level: LoadLevelValue;
    heapRatio: number;
    peerRatio: number;
    peerCount: number;
    maxPeers: number;
  };
  close(): void;

  on(event: "load:elevated", listener: (info: object) => void): this;
  on(event: "load:high", listener: (info: object) => void): this;
  on(event: "load:critical", listener: (info: object) => void): this;
  on(event: "load:shedding", listener: (info: object) => void): this;
  on(event: "load:normal", listener: (info: object) => void): this;
}

// ---------------------------------------------------------------------------
// ModerationBus
// ---------------------------------------------------------------------------

export interface ModerationBusOptions {
  server: SignalingServer;
  policyEngine?: PolicyEngine | null;
  allowSelfUnmute?: boolean;
}

export interface ModerationAction {
  roomId: string;
  targetId: string;
  actorId?: string;
  reason?: string;
}

export declare class ModerationBus extends EventEmitter {
  constructor(options: ModerationBusOptions);

  attach(): this;
  mute(action: ModerationAction): boolean;
  unmute(action: ModerationAction): boolean;
  kick(action: ModerationAction): void;
  warn(action: ModerationAction): void;
  lockRoom(roomId: string, actorId?: string): boolean;
  unlockRoom(roomId: string, actorId?: string): boolean;
  isMuted(roomId: string, peerId: string): boolean;
  isLocked(roomId: string): boolean;
  log(options?: {
    roomId?: string;
    actorId?: string;
    limit?: number;
  }): object[];

  on(event: "muted", listener: (info: object) => void): this;
  on(event: "unmuted", listener: (info: object) => void): this;
  on(event: "kicked", listener: (info: object) => void): this;
  on(event: "warn", listener: (info: object) => void): this;
  on(event: "room:locked", listener: (info: object) => void): this;
  on(event: "room:unlocked", listener: (info: object) => void): this;
  on(event: "abuse:reported", listener: (info: object) => void): this;
}

// ---------------------------------------------------------------------------
// DataResidency
// ---------------------------------------------------------------------------

export interface DataResidencyOptions {
  server: SignalingServer;
  localRegion: string;
  allowedRegions?: string[];
  geoLookup?: (ip: string) => Promise<string>;
  enforceRoomRegion?: boolean;
  enforcePeerRegion?: boolean;
  violationAction?: "reject" | "warn";
}

export declare class DataResidency extends EventEmitter {
  constructor(options: DataResidencyOptions);

  attach(): this;
  resolveRegion(ip: string): Promise<string | null>;
  isAllowed(region: string): boolean;
  tag<T extends object>(obj: T): T & { __region: string };
  stats(): {
    localRegion: string;
    allowedRegions: string[];
    geoCacheSize: number;
  };

  on(event: "violation", listener: (info: object) => void): this;
  on(event: "room:rejected", listener: (info: object) => void): this;
  on(event: "peer:rejected", listener: (info: object) => void): this;
}

// ---------------------------------------------------------------------------
// ConsentFlow
// ---------------------------------------------------------------------------

export type ConsentType = "recording" | "processing" | "sharing" | "analytics";

export interface ConsentRecord {
  peerId: string;
  roomId: string;
  types: ConsentType[];
  version: string;
  grantedAt: number;
  ip: string;
}

export interface ConsentFlowOptions {
  server: SignalingServer;
  required?: ConsentType[];
  allParty?: boolean;
  consentVersion?: string;
  consentTimeoutMs?: number;
}

export declare class ConsentFlow extends EventEmitter {
  constructor(options: ConsentFlowOptions);

  attach(): this;
  getConsent(roomId: string, peerId: string): ConsentRecord | null;
  hasConsented(roomId: string, peerId: string, type: ConsentType): boolean;
  roomHasConsent(roomId: string, type: ConsentType): boolean;
  getRoomConsents(roomId: string): ConsentRecord[];
  recordConsent(roomId: string, peerId: string, types: ConsentType[]): void;
  stats(): Array<{
    roomId: string;
    totalPeers: number;
    consented: number;
    allConsented: boolean;
  }>;

  on(event: "consent:granted", listener: (record: ConsentRecord) => void): this;
  on(
    event: "consent:withdrawn",
    listener: (info: {
      peerId: string;
      roomId: string;
      types: ConsentType[];
      remaining: ConsentType[];
    }) => void,
  ): this;
  on(
    event: "consent:required",
    listener: (info: {
      peerId: string;
      roomId: string;
      types: ConsentType[];
    }) => void,
  ): this;
  on(
    event: "room:consent:complete",
    listener: (info: { roomId: string; type: ConsentType }) => void,
  ): this;
}

// ---------------------------------------------------------------------------
// RetentionPolicy
// ---------------------------------------------------------------------------

export interface RetentionPolicyOptions {
  defaultRetentionMs?: number;
  purgeIntervalMs?: number;
}

export declare class RetentionPolicy extends EventEmitter {
  constructor(options?: RetentionPolicyOptions);

  attach(server: SignalingServer): this;
  register(options: {
    id: string;
    type: string;
    sub: string;
    meta?: object;
  }): object;
  placeLegalHold(sub: string): void;
  releaseLegalHold(sub: string): void;
  purge(dryRun?: boolean): { purged: number; held: number; skipped: number };
  anonymise(sub: string): number;
  recordsFor(sub: string): object[];
  expiringWithin(withinMs: number): object[];
  stats(): { total: number; legalHolds: number; types: object };
  close(): void;

  on(event: "record:purged", listener: (record: object) => void): this;
  on(event: "record:held", listener: (record: object) => void): this;
  on(event: "purge:complete", listener: (stats: object) => void): this;
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export interface AuditLoggerOptions {
  server: SignalingServer;
  filePath?: string;
  maxFileSizeBytes?: number;
  ringSize?: number;
  sink?: (entry: object) => Promise<void>;
  redactIp?: boolean;
  serviceName?: string;
}

export declare class AuditLogger extends EventEmitter {
  constructor(options: AuditLoggerOptions);

  attach(): this;
  log(event: string, meta?: object): void;
  query(options?: {
    limit?: number;
    event?: string;
    peerId?: string;
    roomId?: string;
    since?: number;
  }): object[];
  close(): Promise<void>;

  on(event: "entry", listener: (entry: object) => void): this;
}

// ---------------------------------------------------------------------------
// RecordingPipeline
// ---------------------------------------------------------------------------

export interface RecordingPipelineOptions {
  outputDir: string;
  format?: "webm" | "mp4";
  videoKbps?: number;
  audioKbps?: number;
  onUpload?: (session: object) => Promise<void>;
  autoRecord?: boolean;
}

export declare class RecordingPipeline extends EventEmitter {
  static readonly State: {
    IDLE: "idle";
    RECORDING: "recording";
    STOPPING: "stopping";
    COMPLETED: "completed";
    FAILED: "failed";
  };

  constructor(options: RecordingPipelineOptions);

  attach(server: SignalingServer): this;
  active(): object[];
  index(): object[];
  search(options?: {
    roomId?: string;
    peerId?: string;
    since?: number;
  }): object[];

  on(event: "recording:started", listener: (info: object) => void): this;
  on(event: "recording:stopped", listener: (info: object) => void): this;
  on(event: "recording:error", listener: (info: object) => void): this;
  on(event: "recording:uploaded", listener: (info: object) => void): this;
}

// ---------------------------------------------------------------------------
// GovernanceEndpoints
// ---------------------------------------------------------------------------

export interface GovernanceEndpointsOptions {
  server: SignalingServer;
  adminSecret?: string;
  audit?: AuditLogger;
  consent?: ConsentFlow;
  residency?: DataResidency;
  metrics?: MetricsCollector;
  tracer?: Tracer;
  sessionMgr?: SessionManager;
  sfuOrchestrator?: SFUOrchestrator;
  threatDetector?: ThreatDetector;
}

export declare class GovernanceEndpoints extends EventEmitter {
  constructor(options: GovernanceEndpointsOptions);

  listen(port?: number): import("http").Server;
  router(): (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    next?: () => void,
  ) => void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export declare function createServer(
  options?: SignalingServerOptions,
): SignalingServer;
