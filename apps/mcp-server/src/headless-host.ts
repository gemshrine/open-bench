import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ClientMessage, DiscoveryInfo, ServerMessage, WorkspaceFiles } from '@openbench/core';
import { BRIDGE_PROTOCOL_VERSION, LineBuffer, OpenBenchError, Session, handleApiRequest, toWireError } from '@openbench/core';

/**
 * Node implementation of the GUI side of the bridge, protocol-identical to the Rust shell
 * (apps/desktop/src-tauri/src/bridge.rs). Used by integration tests and as a headless
 * engine for CI; the desktop app remains the normal host.
 */
export class HeadlessHost {
  readonly token = randomBytes(32).toString('hex');
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private queue: Promise<void> = Promise.resolve();
  port = 0;

  constructor(
    readonly session: Session,
    readonly workspace: string,
    readonly discoveryFile: string,
  ) {}

  readonly files: WorkspaceFiles = {
    workspaceDir: async () => this.workspace,
    write: async (rel, text) => {
      const full = await this.resolve(rel);
      const tmp = `${full}.tmp-${process.pid}`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, full);
      return full;
    },
    read: async (rel) => {
      const full = await this.resolve(rel);
      try {
        const st = await stat(full);
        if (st.size > 32 * 1024 * 1024) throw new OpenBenchError('FILE_ERROR', 'Файл слишком большой');
        return { text: await readFile(full, 'utf8'), path: full };
      } catch (e) {
        if (e instanceof OpenBenchError) throw e;
        throw new OpenBenchError('FILE_ERROR', `Не удалось прочитать ${full}: ${(e as Error).message}`);
      }
    },
  };

  private async resolve(rel: string): Promise<string> {
    if (!rel.trim() || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || normalize(rel).split(/[\\/]/).includes('..'))
      throw new OpenBenchError('PATH_NOT_ALLOWED', `Путь должен быть относительным внутри рабочей папки (${this.workspace}), без ".."`);
    const full = join(this.workspace, rel);
    await mkdir(dirname(full), { recursive: true });
    const ws = await realpath(this.workspace);
    const parent = await realpath(dirname(full));
    const r = relative(ws, parent);
    if (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..'))
      throw new OpenBenchError('PATH_NOT_ALLOWED', 'Путь выходит за пределы рабочей папки');
    return full;
  }

  async start(port = 0): Promise<DiscoveryInfo> {
    await mkdir(this.workspace, { recursive: true });
    this.server = createServer((sock) => this.handle(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    const info: DiscoveryInfo = { protocol: BRIDGE_PROTOCOL_VERSION, port: this.port, token: this.token, pid: process.pid, workspace: this.workspace };
    await mkdir(dirname(this.discoveryFile), { recursive: true });
    await writeFile(this.discoveryFile, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
    return info;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    await rm(this.discoveryFile, { force: true });
  }

  private tokenMatches(token: unknown): boolean {
    return typeof token === 'string' && token.length === this.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
  }

  private handle(sock: Socket): void {
    this.sockets.add(sock);
    sock.setEncoding('utf8');
    const lines = new LineBuffer();
    let authed = false;
    const send = (m: ServerMessage) => sock.write(JSON.stringify(m) + '\n');
    const helloTimer = setTimeout(() => !authed && sock.destroy(), 5000);
    sock.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(sock);
    });
    sock.on('error', () => undefined);
    sock.on('data', (chunk: string) => {
      let msgs: string[];
      try {
        msgs = lines.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const line of msgs) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(line) as ClientMessage;
        } catch {
          if (!authed) sock.destroy();
          continue;
        }
        if (!authed) {
          if (msg.type !== 'hello' || !this.tokenMatches(msg.token)) {
            send({ type: 'hello_error', error: { code: 'GUI_NOT_RUNNING', message: 'Неверный токен моста' } });
            sock.end();
            return;
          }
          if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
            send({ type: 'hello_error', error: { code: 'INVALID_ARGUMENT', message: 'Несовместимая версия протокола' } });
            sock.end();
            return;
          }
          authed = true;
          clearTimeout(helloTimer);
          send({ type: 'hello_ok', protocol: BRIDGE_PROTOCOL_VERSION, app: 'OpenBench (headless)' });
          continue;
        }
        if (msg.type !== 'request') continue;
        const req = msg;
        this.queue = this.queue.then(async () => {
          try {
            const result = await handleApiRequest(this.session, req.method, req.params, this.files);
            send({ type: 'response', id: req.id, ok: true, result: result ?? null });
          } catch (e) {
            send({ type: 'response', id: req.id, ok: false, error: toWireError(e) });
          }
        });
      }
    });
  }
}
