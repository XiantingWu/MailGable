interface D1Result<T = unknown> { results?: T[]; success: boolean; meta: unknown; }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
interface R2ObjectBody { body: ReadableStream<Uint8Array>; size: number; }
interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
}
interface Fetcher { fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>; }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
interface ScheduledController { scheduledTime: number; cron: string; noRetry(): void; }
interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}
interface QueueMessage<Body = unknown> {
  id: string;
  timestamp: Date;
  attempts: number;
  body: Body;
}

interface MessageBatch<Body = unknown> {
  queue: string;
  messages: readonly QueueMessage<Body>[];
}

type ExportedHandler<Env = unknown> = {
  fetch?: (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
  email?: (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => void | Promise<void>;
  queue?: (batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) => void | Promise<void>;
  scheduled?: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => void | Promise<void>;
};
