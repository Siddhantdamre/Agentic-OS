import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Redis pub/sub bus for dashboard SSE (WS-11 / I3 / H7).
 *
 * Topics are `org:{id}`. Uses the Nango Redis instance (`redis:6379` in
 * compose, `REDIS_URL`). Never langfuse-redis — that instance is Langfuse-only.
 *
 * One publisher socket + one subscriber socket per process. Two dashboard
 * replicas both receive PUBLISH because Redis fans out to every SUBSCRIBE.
 */

export type EventBusHandler = (channel: string, payload: string) => void;

const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 5_000;
const RECONNECT_MAX_MS = 5_000;
const MAX_RESP_BUFFER = 1024 * 1024;

type RespValue = string | number | null | RespValue[] | { error: string };

type RedisTarget = {
  host: string;
  port: number;
  password: string;
  username: string;
  tls: boolean;
};

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build';
}

export function orgTopic(orgId: string): string {
  if (!orgId) {
    throw new Error('[event-bus] org id is required to build a topic');
  }
  return `org:${orgId}`;
}

export function parseOrgTopic(channel: string): string | null {
  if (!channel.startsWith('org:')) return null;
  const orgId = channel.slice(4);
  return orgId || null;
}

function resolveRedisUrl(): string {
  const configured = process.env.REDIS_URL?.trim() || '';
  const url = configured || (isProductionRuntime() ? '' : 'redis://127.0.0.1:6379');
  if (!url) {
    throw new Error(
      '[event-bus] REDIS_URL must be set. Point it at the Nango Redis service (redis://redis:6379 in compose, redis://127.0.0.1:6379 on the host). Never langfuse-redis.'
    );
  }
  if (/langfuse-redis/i.test(url)) {
    throw new Error(
      '[event-bus] REDIS_URL points at langfuse-redis. The SSE bus must use the Nango `redis` service (I3), not Langfuse Redis.'
    );
  }
  return url;
}

export function parseRedisTarget(urlString: string): RedisTarget {
  const url = new URL(urlString);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`[event-bus] REDIS_URL must be redis:// or rediss:// (got ${url.protocol})`);
  }
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 6379,
    password: decodeURIComponent(url.password || ''),
    username: decodeURIComponent(url.username || ''),
    tls: url.protocol === 'rediss:',
  };
}

function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const data = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

function parseResp(buf: Buffer, pos: { i: number }): RespValue | undefined {
  const start = pos.i;
  if (pos.i >= buf.length) return undefined;
  const type = buf[pos.i];
  const headerEnd = buf.indexOf('\r\n', pos.i);
  if (headerEnd === -1) return undefined;

  const reset = (): undefined => {
    pos.i = start;
    return undefined;
  };

  if (type === 0x2b /* + */) {
    const value = buf.subarray(pos.i + 1, headerEnd).toString('utf8');
    pos.i = headerEnd + 2;
    return value;
  }
  if (type === 0x2d /* - */) {
    const value = buf.subarray(pos.i + 1, headerEnd).toString('utf8');
    pos.i = headerEnd + 2;
    return { error: value };
  }
  if (type === 0x3a /* : */) {
    const value = Number(buf.subarray(pos.i + 1, headerEnd).toString('ascii'));
    pos.i = headerEnd + 2;
    return value;
  }
  if (type === 0x24 /* $ */) {
    const len = Number(buf.subarray(pos.i + 1, headerEnd).toString('ascii'));
    if (len < 0) {
      pos.i = headerEnd + 2;
      return null;
    }
    const dataStart = headerEnd + 2;
    const dataEnd = dataStart + len;
    if (buf.length < dataEnd + 2) return reset();
    const value = buf.subarray(dataStart, dataEnd).toString('utf8');
    pos.i = dataEnd + 2;
    return value;
  }
  if (type === 0x2a /* * */) {
    const count = Number(buf.subarray(pos.i + 1, headerEnd).toString('ascii'));
    pos.i = headerEnd + 2;
    if (count < 0) return null;
    const items: RespValue[] = [];
    for (let n = 0; n < count; n++) {
      const item = parseResp(buf, pos);
      if (item === undefined) return reset();
      items.push(item);
    }
    return items;
  }
  throw new Error(`[event-bus] unknown RESP type 0x${type.toString(16)}`);
}

function respError(value: RespValue): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    return value.error;
  }
  return null;
}

function openSocket(target: RedisTarget): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = target.tls
      ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
      : createConnection({ host: target.host, port: target.port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`[event-bus] connect timeout to ${target.host}:${target.port}`));
    }, CONNECT_TIMEOUT_MS);

    const onFail = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };

    socket.once('error', onFail);
    socket.once(target.tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.off('error', onFail);
      socket.setKeepAlive(true, 15_000);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

type PendingCommand = {
  resolve: (value: RespValue) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class RedisLink {
  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private readonly pending: PendingCommand[] = [];
  private connecting: Promise<void> | null = null;
  private reconnectDelay = 250;
  private closed = false;
  private handshakeDone = false;
  private everConnected = false;
  private readonly push = new EventEmitter();

  constructor(
    private readonly name: string,
    private readonly subscribeMode: boolean,
  ) {
    this.push.setMaxListeners(200);
  }

  onPush(event: string, handler: (value: RespValue) => void): () => void {
    this.push.on(event, handler);
    return () => this.push.off(event, handler);
  }

  async ready(): Promise<void> {
    if (this.handshakeDone && this.socket && !this.socket.destroyed) return;
    if (!this.connecting) this.connecting = this.connect();
    await this.connecting;
  }

  async command(args: string[]): Promise<RespValue> {
    await this.ready();
    return this.commandInternal(args);
  }

  destroy(): void {
    this.closed = true;
    this.handshakeDone = false;
    this.failPending(new Error(`[event-bus] ${this.name} closed`));
    this.socket?.destroy();
    this.socket = null;
  }

  private commandInternal(args: string[]): Promise<RespValue> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error(`[event-bus] ${this.name} socket is down`));
    }
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`[event-bus] ${this.name} command timeout: ${args[0]}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
      socket.write(encodeCommand(args));
    });
  }

  private async connect(): Promise<void> {
    try {
      const target = parseRedisTarget(resolveRedisUrl());
      const socket = await openSocket(target);
      this.socket = socket;
      this.buf = Buffer.alloc(0);
      this.handshakeDone = false;

      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', (err) => {
        console.error(`[event-bus] ${this.name} socket error:`, err.message);
      });
      socket.on('close', () => {
        this.handshakeDone = false;
        this.socket = null;
        this.failPending(new Error(`[event-bus] ${this.name} disconnected`));
        this.scheduleReconnect();
      });

      if (target.password) {
        const auth = target.username
          ? await this.commandInternal(['AUTH', target.username, target.password])
          : await this.commandInternal(['AUTH', target.password]);
        const err = respError(auth);
        if (err) throw new Error(`[event-bus] AUTH failed: ${err}`);
      } else {
        const ping = await this.commandInternal(['PING']);
        const err = respError(ping);
        if (err) throw new Error(`[event-bus] PING failed: ${err}`);
      }

      this.handshakeDone = true;
      this.reconnectDelay = 250;
      if (this.everConnected) {
        this.push.emit('reconnected', []);
      }
      this.everConnected = true;
    } catch (err) {
      this.connecting = null;
      this.handshakeDone = false;
      this.socket?.destroy();
      this.socket = null;
      throw err;
    } finally {
      if (this.handshakeDone) this.connecting = null;
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_RESP_BUFFER) {
      console.error(`[event-bus] ${this.name} RESP buffer overflow — resetting socket`);
      this.socket?.destroy();
      return;
    }
    while (this.buf.length > 0) {
      const pos = { i: 0 };
      let value: RespValue | undefined;
      try {
        value = parseResp(this.buf, pos);
      } catch (err) {
        console.error(`[event-bus] ${this.name} RESP parse error:`, err);
        this.socket?.destroy();
        return;
      }
      if (value === undefined) break;
      this.buf = this.buf.subarray(pos.i);
      this.dispatch(value);
    }
  }

  private dispatch(value: RespValue): void {
    if (this.subscribeMode && Array.isArray(value) && typeof value[0] === 'string') {
      const kind = value[0];
      if (kind === 'message' || kind === 'pmessage') {
        this.push.emit(kind, value);
        return;
      }
      if (kind === 'subscribe' || kind === 'unsubscribe' || kind === 'pong') {
        this.push.emit(kind, value);
        this.resolvePending(value);
        return;
      }
    }
    this.resolvePending(value);
  }

  private resolvePending(value: RespValue): void {
    const next = this.pending.shift();
    if (!next) return;
    clearTimeout(next.timer);
    const err = respError(value);
    if (err) next.reject(new Error(`[event-bus] Redis error: ${err}`));
    else next.resolve(value);
  }

  private failPending(err: Error): void {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) break;
      clearTimeout(next.timer);
      next.reject(err);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.connecting = null;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    console.error(`[event-bus] ${this.name} reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (this.closed) return;
      this.ready().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[event-bus] ${this.name} reconnect failed:`, message);
      });
    }, delay);
  }
}

class EventBus {
  private readonly publisher = new RedisLink('publisher', false);
  private readonly subscriber = new RedisLink('subscriber', true);
  private readonly handlers = new Map<string, Set<EventBusHandler>>();
  private readonly subscribed = new Set<string>();
  private pushBound = false;

  async ensureReady(): Promise<void> {
    this.bindPush();
    await Promise.all([this.publisher.ready(), this.subscriber.ready()]);
  }

  async publish(channel: string, payload: string): Promise<void> {
    try {
      await this.publisher.ready();
      const result = await this.publisher.command(['PUBLISH', channel, payload]);
      if (typeof result === 'number' && result === 0) {
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[event-bus] PUBLISH failed on ${channel} — event not delivered:`, message);
      throw err;
    }
  }

  async subscribe(channel: string, handler: EventBusHandler): Promise<() => void> {
    await this.ensureReady();
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    try {
      await this.ensureChannel(channel);
    } catch (err) {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(channel);
      throw err;
    }
    return () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        this.dropChannel(channel);
      }
    };
  }

  private bindPush(): void {
    if (this.pushBound) return;
    this.pushBound = true;
    this.subscriber.onPush('message', (value) => {
      if (!Array.isArray(value) || value.length < 3) return;
      const channel = typeof value[1] === 'string' ? value[1] : '';
      const payload = typeof value[2] === 'string' ? value[2] : '';
      if (!channel) return;
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const handler of set) {
        try {
          handler(channel, payload);
        } catch (err) {
          console.error('[event-bus] subscriber handler threw:', err);
        }
      }
    });
    this.subscriber.onPush('reconnected', () => {
      this.subscribed.clear();
      this.resubscribeAll().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[event-bus] resubscribe after reconnect failed:', message);
      });
    });
  }

  private async ensureChannel(channel: string): Promise<void> {
    if (this.subscribed.has(channel)) return;
    await this.subscriber.ready();
    await this.subscriber.command(['SUBSCRIBE', channel]);
    this.subscribed.add(channel);
  }

  private dropChannel(channel: string): void {
    if (!this.subscribed.has(channel)) return;
    this.subscribed.delete(channel);
    this.subscriber.command(['UNSUBSCRIBE', channel]).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[event-bus] UNSUBSCRIBE ${channel} failed:`, message);
    });
  }

  private async resubscribeAll(): Promise<void> {
    const channels = [...this.handlers.keys()];
    this.subscribed.clear();
    for (const channel of channels) {
      await this.ensureChannel(channel);
    }
  }
}

const globalForBus = globalThis as unknown as { darexEventBus?: EventBus };

export const eventBus = globalForBus.darexEventBus ?? new EventBus();

if (process.env.NODE_ENV !== 'production') {
  globalForBus.darexEventBus = eventBus;
}
