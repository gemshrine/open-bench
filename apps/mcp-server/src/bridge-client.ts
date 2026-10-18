import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { DiscoveryInfo, ServerMessage } from '@openbench/core';
import { BRIDGE_PROTOCOL_VERSION, LineBuffer, OpenBenchError, fromWireError } from '@openbench/core';
import { readDiscovery } from './discovery.js';

export interface BridgeCall {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client side of the GUI bridge. Connects lazily on the first call, re-reads the discovery
 * file on every (re)connect, and fails every pending call with GUI_NOT_RUNNING when the
 * GUI goes away. The next call will try to reconnect, so restarting the GUI is enough.
 */
export class BridgeClient implements BridgeCall {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly discover: () => Promise<DiscoveryInfo> = () => readDiscovery(),
    private readonly timeoutMs = 20000,
  ) {}

  private connectOnce(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const info = await this.discover();
      return await new Promise<Socket>((resolve, reject) => {
        const sock = connect({ host: '127.0.0.1', port: info.port });
        const lines = new LineBuffer();
        let authed = false;
        sock.setEncoding('utf8');
        sock.setNoDelay(true);
        const fail = (e: OpenBenchError) => {
          sock.destroy();
          reject(e);
        };
        sock.once('error', (err) => {
          if (!authed) fail(new OpenBenchError('GUI_NOT_RUNNING', `Не удалось подключиться к OpenBench (127.0.0.1:${info.port}): ${err.message}. Запущено ли приложение?`));
        });
        sock.on('data', (chunk: string) => {
          let msgs: string[];
          try {
            msgs = lines.push(chunk);
          } catch (e) {
            sock.destroy(e as Error);
            return;
          }
          for (const line of msgs) {
            let msg: ServerMessage;
            try {
              msg = JSON.parse(line) as ServerMessage;
            } catch {
              continue;
            }
            if (!authed) {
              if (msg.type === 'hello_ok') {
                authed = true;
                this.socket = sock;
                resolve(sock);
              } else if (msg.type === 'hello_error') {
                fail(fromWireError(msg.error));
              }
              continue;
            }
            if (msg.type === 'response') {
              const p = this.pending.get(msg.id);
              if (!p) continue;
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.ok) p.resolve(msg.result);
              else p.reject(fromWireError(msg.error));
            }
          }
        });
        sock.on('close', () => {
          if (this.socket === sock) this.socket = null;
          if (!authed) reject(new OpenBenchError('GUI_NOT_RUNNING', 'OpenBench закрыл соединение до авторизации'));
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new OpenBenchError('GUI_NOT_RUNNING', 'Соединение с OpenBench разорвано (окно закрыто?)'));
            this.pending.delete(id);
          }
        });
        sock.write(JSON.stringify({ type: 'hello', token: info.token, protocol: BRIDGE_PROTOCOL_VERSION, client: 'openbench-mcp' }) + '\n');
      });
    })();
    return this.connecting.finally(() => {
      this.connecting = null;
    });
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    const sock = await this.connectOnce();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OpenBenchError('GUI_NOT_RUNNING', `OpenBench не ответил за ${this.timeoutMs / 1000} с на ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(JSON.stringify({ type: 'request', id, method, params }) + '\n');
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
