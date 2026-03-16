'use strict';

/**
 * @file RecordingAdapter.js
 * @description ffmpeg-backed recording adapter for webrtc-rooms.
 *
 * Records individual peer streams or entire rooms to disk. Attach it to a
 * {@link SignalingServer} to enable auto-recording, or control recordings
 * manually via the `startPeer` / `stopPeer` / `startRoom` / `stopRoom` API.
 *
 * **Prerequisites**
 * - `ffmpeg` must be installed and available on `PATH`.
 * - For real media capture, the server must use `wrtc` (node-webrtc) peer
 *   connections. In signaling-only deployments the adapter runs the ffmpeg
 *   process with a synthetic test source instead.
 *
 * @module webrtc-rooms/adapters/RecordingAdapter
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Milliseconds to wait for ffmpeg to flush its output buffers and exit cleanly
 * after stdin is closed. If ffmpeg has not exited within this window the process
 * is force-killed with SIGKILL to prevent zombie processes.
 *
 * @constant {number}
 */
const FFMPEG_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Adapter that records peer audio/video streams to disk via an ffmpeg child
 * process.
 *
 * @extends EventEmitter
 *
 * @example
 * const { createServer, RecordingAdapter } = require('webrtc-rooms');
 *
 * const server   = createServer({ port: 3000 });
 * const recorder = new RecordingAdapter({
 *   outputDir: './recordings',
 *   format: 'webm',
 * });
 *
 * recorder.attach(server); // auto-records all peers
 *
 * recorder.on('recording:stopped', ({ peerId, path, durationMs }) => {
 *   console.log(`Saved ${path} (${durationMs}ms)`);
 * });
 *
 * @fires RecordingAdapter#recording:started
 * @fires RecordingAdapter#recording:stopped
 * @fires RecordingAdapter#recording:error
 * @fires RecordingAdapter#recording:progress
 * @fires RecordingAdapter#recording:room:started
 * @fires RecordingAdapter#recording:room:stopped
 */
class RecordingAdapter extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}  options.outputDir
   *   Directory where recording files are written. Created automatically if it
   *   does not exist.
   * @param {string}  [options.format='webm']
   *   Output container. `'webm'` encodes VP8 + Opus; `'mp4'` encodes H.264 +
   *   AAC (requires `libx264` in your ffmpeg build).
   * @param {number}  [options.videoKbps=800]  Target video bitrate in kbit/s.
   * @param {number}  [options.audioKbps=128]  Target audio bitrate in kbit/s.
   * @param {object}  [options.ffmpegArgs={}]
   *   Extra ffmpeg flags to merge into the command, expressed as
   *   `{ '-flag': 'value' }` pairs.
   */
  constructor({
    outputDir,
    format = 'webm',
    videoKbps = 800,
    audioKbps = 128,
    ffmpegArgs = {},
  } = {}) {
    super();

    if (!outputDir) throw new Error('[RecordingAdapter] options.outputDir is required');

    this.outputDir = outputDir;
    this.format = format;
    this.videoKbps = videoKbps;
    this.audioKbps = audioKbps;
    this.ffmpegArgs = ffmpegArgs;

    /**
     * Active recordings keyed by peer ID.
     *
     * @private
     * @type {Map<string, { process: ChildProcess, filePath: string, startedAt: number, roomId: string }>}
     */
    this._recordings = new Map();

    /**
     * Room-level recording index: roomId → Set of peer IDs being recorded.
     *
     * @private
     * @type {Map<string, Set<string>>}
     */
    this._roomRecordings = new Map();

    /** @private @type {import('../SignalingServer')|null} */
    this._server = null;

    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * Attaches this adapter to a {@link SignalingServer}.
   *
   * After attaching:
   * - Peers joining a room that has an active room-level recording are
   *   automatically recorded.
   * - Peers that disconnect have their individual recording automatically
   *   stopped and finalised.
   *
   * @param {import('../SignalingServer')} server
   * @returns {this} Returns `this` for chaining.
   */
  attach(server) {
    this._server = server;

    server.on('peer:joined', (peer, room) => {
      if (this._roomRecordings.has(room.id)) {
        this.startPeer(peer.id, room.id).catch((err) => {
          console.error(`[RecordingAdapter] Auto-start failed for peer "${peer.id}":`, err.message);
        });
      }
    });

    server.on('peer:left', (peer) => {
      if (this._recordings.has(peer.id)) {
        this.stopPeer(peer.id).catch((err) => {
          console.error(`[RecordingAdapter] Auto-stop failed for peer "${peer.id}":`, err.message);
        });
      }
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Per-peer recording
  // ---------------------------------------------------------------------------

  /**
   * Starts recording a peer's media stream.
   *
   * In a deployment using `wrtc` (node-webrtc), this would tap into the
   * server-side `RTCPeerConnection` and pipe the raw RTP streams to ffmpeg.
   * In a signaling-only deployment a synthetic lavfi test source is used so
   * the interface remains consistent for development and testing.
   *
   * @param {string} peerId            - ID of the peer to record.
   * @param {string} [roomId='default']
   *   Room ID used to organise output files into subdirectories.
   * @returns {Promise<{ path: string }>}
   * @throws {Error} If the peer is already being recorded.
   *
   * @fires RecordingAdapter#recording:started
   */
  async startPeer(peerId, roomId = 'default') {
    if (this._recordings.has(peerId)) {
      throw new Error(`[RecordingAdapter] Peer "${peerId}" is already being recorded`);
    }

    const dir = path.join(this.outputDir, roomId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = this.format === 'mp4' ? 'mp4' : 'webm';
    const filePath = path.join(dir, `${peerId.slice(0, 8)}-${timestamp}.${extension}`);

    fs.mkdirSync(dir, { recursive: true });

    const ffmpegCommand = this._buildFfmpegArgs(filePath);
    const proc = spawn('ffmpeg', ffmpegCommand, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.includes('time=') || line.toLowerCase().includes('error')) {
        /**
         * @event RecordingAdapter#recording:progress
         * @param {{ peerId: string, roomId: string, line: string }}
         */
        this.emit('recording:progress', { peerId, roomId, line: line.trim() });
      }
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(
          '[RecordingAdapter] ffmpeg was not found. Install ffmpeg and ensure it is on PATH.',
        );
      }
      /**
       * @event RecordingAdapter#recording:error
       * @param {{ peerId: string, roomId: string, error: Error }}
       */
      this.emit('recording:error', { peerId, roomId, error: err });
    });

    this._recordings.set(peerId, { process: proc, filePath, startedAt: Date.now(), roomId });

    /**
     * @event RecordingAdapter#recording:started
     * @param {{ peerId: string, roomId: string, path: string }}
     */
    this.emit('recording:started', { peerId, roomId, path: filePath });
    console.log(`[RecordingAdapter] Recording started: peer "${peerId.slice(0, 8)}" → ${filePath}`);

    return { path: filePath };
  }

  /**
   * Stops an active peer recording and finalises the output file.
   *
   * Signals ffmpeg to flush and close by ending its stdin pipe, then waits
   * for the process to exit cleanly. If ffmpeg does not exit within
   * {@link FFMPEG_FLUSH_TIMEOUT_MS} milliseconds, it is force-killed.
   *
   * @param {string} peerId
   * @returns {Promise<{ path: string, durationMs: number }>}
   * @throws {Error} If the peer is not currently being recorded, or ffmpeg
   *   exits with a non-zero code.
   *
   * @fires RecordingAdapter#recording:stopped
   * @fires RecordingAdapter#recording:error
   */
  stopPeer(peerId) {
    return new Promise((resolve, reject) => {
      const record = this._recordings.get(peerId);
      if (!record) {
        return reject(new Error(`[RecordingAdapter] Peer "${peerId}" is not being recorded`));
      }

      const { process: proc, filePath, startedAt, roomId } = record;
      const durationMs = Date.now() - startedAt;

      // Ending stdin signals ffmpeg to flush its buffers and write the file trailer.
      proc.stdin.end();

      const forceKillTimer = setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, FFMPEG_FLUSH_TIMEOUT_MS);

      proc.on('close', (code) => {
        clearTimeout(forceKillTimer);
        this._recordings.delete(peerId);

        const peerSet = this._roomRecordings.get(roomId);
        if (peerSet) {
          peerSet.delete(peerId);
          if (peerSet.size === 0) this._roomRecordings.delete(roomId);
        }

        const result = { path: filePath, durationMs };

        if (code === 0 || code === null) {
          /**
           * @event RecordingAdapter#recording:stopped
           * @param {{ peerId: string, roomId: string, path: string, durationMs: number }}
           */
          this.emit('recording:stopped', { peerId, roomId, ...result });
          console.log(
            `[RecordingAdapter] Recording stopped: peer "${peerId.slice(0, 8)}" (${(durationMs / 1000).toFixed(1)}s)`,
          );
          resolve(result);
        } else {
          const err = new Error(`ffmpeg exited with code ${code}`);
          this.emit('recording:error', { peerId, roomId, error: err });
          reject(err);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Room-level recording
  // ---------------------------------------------------------------------------

  /**
   * Starts recording every peer currently in a room.
   *
   * Any peers that join the room after this call will also be recorded
   * automatically (as long as the adapter is attached to the server).
   *
   * @param {string} roomId
   * @returns {Promise<{ started: string[] }>} IDs of peers whose recordings began.
   * @throws {Error} If the adapter is not attached to a server, or the room
   *   does not exist.
   *
   * @fires RecordingAdapter#recording:room:started
   */
  async startRoom(roomId) {
    if (!this._server) {
      throw new Error('[RecordingAdapter] Call .attach(server) before startRoom()');
    }

    const room = this._server.getRoom(roomId);
    if (!room) throw new Error(`[RecordingAdapter] Room "${roomId}" not found`);

    this._roomRecordings.set(roomId, new Set());

    const started = [];
    for (const peerId of room.peers.keys()) {
      await this.startPeer(peerId, roomId);
      this._roomRecordings.get(roomId).add(peerId);
      started.push(peerId);
    }

    /**
     * @event RecordingAdapter#recording:room:started
     * @param {{ roomId: string, peers: string[] }}
     */
    this.emit('recording:room:started', { roomId, peers: started });
    return { started };
  }

  /**
   * Stops all active recordings for a room and removes the room from the
   * auto-record list.
   *
   * Failures to stop individual peers are logged but do not abort the
   * remaining stops.
   *
   * @param {string} roomId
   * @returns {Promise<Array<{ path: string, durationMs: number }>>}
   *
   * @fires RecordingAdapter#recording:room:stopped
   */
  async stopRoom(roomId) {
    const peerIds = [...(this._roomRecordings.get(roomId) ?? [])];
    const results = [];

    for (const peerId of peerIds) {
      try {
        results.push(await this.stopPeer(peerId));
      } catch (err) {
        console.error(
          `[RecordingAdapter] stopRoom: could not stop peer "${peerId}":`,
          err.message,
        );
      }
    }

    this._roomRecordings.delete(roomId);

    /**
     * @event RecordingAdapter#recording:room:stopped
     * @param {{ roomId: string, files: Array<{ path: string, durationMs: number }> }}
     */
    this.emit('recording:room:stopped', { roomId, files: results });
    return results;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Returns a list of all currently active recordings.
   *
   * @returns {Array<{ peerId: string, roomId: string, filePath: string, durationMs: number }>}
   */
  activeRecordings() {
    const now = Date.now();
    return [...this._recordings.entries()].map(([peerId, record]) => ({
      peerId,
      roomId: record.roomId,
      filePath: record.filePath,
      durationMs: now - record.startedAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Builds the ffmpeg argument array for a new recording process.
   *
   * In a production `wrtc` integration, replace the lavfi test source inputs
   * with the actual RTP source descriptors from the server-side peer
   * connections.
   *
   * @private
   * @param {string} outputPath
   * @returns {string[]}
   */
  _buildFfmpegArgs(outputPath) {
    // Synthetic inputs for signaling-only or development deployments.
    // In a wrtc integration these would be replaced with RTP demuxer inputs.
    const inputs = [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
    ];

    const videoCodec = this.format === 'mp4'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${this.videoKbps}k`]
      : ['-c:v', 'libvpx', '-b:v', `${this.videoKbps}k`];

    const audioCodec = this.format === 'mp4'
      ? ['-c:a', 'aac', '-b:a', `${this.audioKbps}k`]
      : ['-c:a', 'libopus', '-b:a', `${this.audioKbps}k`];

    const overrides = Object.entries(this.ffmpegArgs).flatMap(([k, v]) => [k, String(v)]);

    return [...inputs, ...videoCodec, ...audioCodec, ...overrides, outputPath];
  }
}

module.exports = RecordingAdapter;