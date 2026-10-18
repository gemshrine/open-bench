import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Session, parseProjectText } from '@openbench/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessHost } from '../src/headless-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'src', 'index.ts');

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text: string }[];
}

async function startClient(bridgeFile: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverEntry],
    cwd: join(here, '..'),
    env: { ...(process.env as Record<string, string>), OPENBENCH_BRIDGE_FILE: bridgeFile },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'openbench-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP server ⇄ bridge ⇄ engine', () => {
  let dir: string;
  let host: HeadlessHost;
  let client: Client;
  /** Stands in for the GUI: the very session object the window would render. */
  let guiSession: Session;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const data = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
    return r.structuredContent as Record<string, unknown>;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openbench-mcp-'));
    guiSession = new Session();
    host = new HeadlessHost(guiSession, join(dir, 'workspace'), join(dir, 'bridge.json'));
    await host.start();
    client = await startClient(join(dir, 'bridge.json'));
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await host?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the required tools with input schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const required of [
      'get_project_state',
      'new_project',
      'add_component',
      'move_component',
      'remove_component',
      'connect_pins',
      'disconnect_pins',
      'set_input',
      'set_word_sequence',
      'configure_word_generator',
      'attach_analyzer_channel',
      'simulation_step',
      'simulation_reset',
      'get_signal_values',
      'get_analyzer_history',
      'save_project',
      'open_project',
    ]) {
      expect(names).toContain(required);
    }
    const add = tools.find((t) => t.name === 'add_component')!;
    expect(add.inputSchema.properties).toHaveProperty('type');
  });

  it('scenario 1 (AND) through MCP; the GUI session sees the same circuit', async () => {
    await data('new_project', { title: 'AND lab' });
    const wg = await data('add_component', { type: 'WORD_GENERATOR', x: 20, y: 20 });
    expect((wg.component as { id: string }).id).toBe('wg');
    const and = await data('add_component', { type: 'AND', x: 200, y: 150 });
    expect((and.pins as { id: string }[]).map((p) => p.id)).toEqual(['and1.A', 'and1.B', 'and1.OUT']);
    await data('add_component', { type: 'LOGIC_ANALYZER', x: 400, y: 20 });
    await data('connect_pins', { from: 'wg.D0', to: 'and1.A' });
    await data('connect_pins', { from: 'wg.D1', to: 'and1.B' });
    await data('attach_analyzer_channel', { channel: 0, target: 'and1.OUT' });
    await data('attach_analyzer_channel', { channel: 1, target: 'wg.D0' });
    await data('attach_analyzer_channel', { channel: 2, target: 'wg.D1' });
    await data('set_word_sequence', { words: ['0x0000', '0x0001', '0x0002', '0x0003'] });
    const step = await data('simulation_step', { count: 4 });
    expect(step.executed).toBe(4);
    const hist = await data('get_analyzer_history', { channels: [0, 1, 2] });
    const ch = hist.channels as Record<string, { values: unknown[] }>;
    expect(ch.CH0!.values).toEqual([0, 0, 0, 1]);
    expect(ch.CH1!.values).toEqual([0, 1, 0, 1]);
    expect(ch.CH2!.values).toEqual([0, 0, 1, 1]);
    // Same data in the GUI-side engine instance (single source of truth).
    expect(guiSession.circuit.components.map((c) => c.id)).toEqual(['wg', 'and1', 'la']);
    expect(guiSession.history.map((f) => f.channels[0])).toEqual([0, 0, 0, 1]);
  });

  it('scenario 2 (XOR) through MCP', async () => {
    await data('new_project', {});
    await data('add_component', { type: 'WORD_GENERATOR', x: 20, y: 20 });
    await data('add_component', { type: 'XOR', x: 200, y: 150 });
    await data('connect_pins', { from: 'wg.D0', to: 'xor1.A' });
    await data('connect_pins', { from: 'wg.D1', to: 'xor1.B' });
    await data('attach_analyzer_channel', { channel: 0, target: 'xor1.OUT' });
    await data('set_word_sequence', { words: [0, 1, 2, 3] });
    await data('simulation_step', { count: 4 });
    const hist = await data('get_analyzer_history', { channels: [0] });
    expect((hist.channels as Record<string, { values: unknown[] }>).CH0!.values).toEqual([0, 1, 1, 0]);
  });

  it('scenario 4 (sync): MCP edits appear in the GUI session, GUI input changes are visible to MCP', async () => {
    await data('new_project', {});
    await data('add_component', { type: 'INPUT', x: 0, y: 0, id: 'sw' });
    await data('add_component', { type: 'NOT', x: 100, y: 0 });
    await data('add_component', { type: 'OUTPUT', x: 200, y: 0, id: 'lamp' });
    await data('connect_pins', { from: 'sw.OUT', to: 'not1.A' });
    await data('connect_pins', { from: 'not1.OUT', to: 'lamp.IN' });
    expect(guiSession.circuit.wires).toHaveLength(2);
    expect(guiSession.result.pins.get('lamp.IN')).toBe(1);
    guiSession.toggleInput('sw'); // user flips the switch in the window
    const v = await data('get_signal_values', { ids: ['lamp', 'sw'] });
    expect(v.values).toEqual({ lamp: 0, sw: 1 });
  });

  it('scenario 3 (save/open) within the workspace, rejecting paths outside it', async () => {
    await data('new_project', { title: 'save test' });
    await data('add_component', { type: 'WORD_GENERATOR', x: 20, y: 20 });
    await data('add_component', { type: 'AND', x: 200, y: 150 });
    await data('connect_pins', { from: 'wg.D0', to: 'and1.A' });
    await data('connect_pins', { from: 'wg.D1', to: 'and1.B' });
    await data('attach_analyzer_channel', { channel: 0, target: 'and1.OUT' });
    await data('set_word_sequence', { words: [0, 1, 2, 3] });
    await data('move_component', { id: 'and1', x: 250, y: 170 });
    const saved = await data('save_project', { path: 'labs/and.openbench.json' });
    const before = guiSession.circuit;
    const text = await readFile(saved.path as string, 'utf8');
    expect(parseProjectText(text)).toEqual(before);

    await data('new_project', {});
    expect(guiSession.circuit.components).toHaveLength(0);
    await data('open_project', { path: 'labs/and.openbench.json' });
    expect(guiSession.circuit).toEqual(before);
    await data('simulation_step', { count: 4 });
    const hist = await data('get_analyzer_history', { channels: [0] });
    expect((hist.channels as Record<string, { values: unknown[] }>).CH0!.values).toEqual([0, 0, 0, 1]);

    for (const bad of ['../evil.openbench.json', 'C:/Windows/evil.openbench.json', '/etc/evil.openbench.json', 'a/../../evil.openbench.json']) {
      const r = await call('save_project', { path: bad });
      expect(r.isError, bad).toBe(true);
      expect(r.content[0]!.text).toContain('PATH_NOT_ALLOWED');
    }
    const wrongExt = await call('save_project', { path: 'notes.txt' });
    expect(wrongExt.content[0]!.text).toContain('PATH_NOT_ALLOWED');
  });

  it('returns structured, distinguishable errors', async () => {
    await data('new_project', {});
    await data('add_component', { type: 'CONST0', x: 0, y: 0 });
    await data('add_component', { type: 'CONST1', x: 50, y: 0 });
    const conflict = await call('connect_pins', { from: 'gnd1.OUT', to: 'vcc1.OUT' });
    expect(conflict.isError).toBe(true);
    expect(JSON.parse(conflict.content[0]!.text).error.code).toBe('DRIVER_CONFLICT');
    const badId = await call('connect_pins', { from: 'nope.A', to: 'gnd1.OUT' });
    expect(JSON.parse(badId.content[0]!.text).error.code).toBe('INVALID_ID');
    const tooMany = await call('simulation_step', { count: 20000 });
    expect(tooMany.isError).toBe(true);
    await data('set_word_sequence', { words: [] });
    const empty = await call('simulation_step', { count: 1 });
    expect(JSON.parse(empty.content[0]!.text).error.code).toBe('SEQUENCE_EMPTY');
    expect(guiSession.circuit.wires).toHaveLength(0); // failed calls changed nothing
  });

  it('reports GUI_NOT_RUNNING when no OpenBench window is available', async () => {
    const lonely = await startClient(join(dir, 'missing', 'bridge.json'));
    try {
      const r = (await lonely.callTool({ name: 'get_project_state', arguments: {} })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error.code).toBe('GUI_NOT_RUNNING');
    } finally {
      await lonely.close();
    }
  });
});
