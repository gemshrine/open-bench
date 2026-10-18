import { z } from 'zod';
import { componentPins } from './commands.js';
import { OpenBenchError, fail } from './errors.js';
import { serializeCircuit, parseProjectText } from './schema.js';
import type { Frame, Session } from './session.js';
import type { Signal } from './types.js';
import { ANALYZER_CHANNELS, COMPONENT_TYPES, MAX_GATE_INPUTS, MAX_STEPS_PER_CALL, MAX_WORDS, MIN_GATE_INPUTS } from './types.js';

/**
 * File access provided by the host (GUI). Paths given by the MCP side are always
 * relative to the host's workspace directory; the host resolves and confines them.
 */
export interface WorkspaceFiles {
  /** Writes atomically; returns the absolute path written. */
  write(relativePath: string, text: string): Promise<string>;
  /** Returns file text and its absolute path. */
  read(relativePath: string): Promise<{ text: string; path: string }>;
  workspaceDir(): Promise<string>;
}

const pinRef = z.string().min(3).max(130).describe('Вывод в формате <componentId>.<pin>, например "and1.A", или ID узла (junction)');
const word = z.union([
  z.number().int().min(0).max(0xffff),
  z.string().regex(/^(0x[0-9a-fA-F]{1,4}|0b[01]{1,16}|[0-9]{1,5})$/, 'Слово: число, "0x1A2B" или "0b0101"'),
]);

/** Input schemas for every API method (also used verbatim as MCP tool input schemas). */
export const API_SCHEMAS = {
  get_project_state: z.object({}),
  new_project: z.object({ title: z.string().max(200).optional() }),
  add_component: z.object({
    type: z.enum(COMPONENT_TYPES),
    x: z.number().finite().describe('Координата X левого верхнего угла (сетка 10)'),
    y: z.number().finite().describe('Координата Y левого верхнего угла (сетка 10)'),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe('Необязательный желаемый ID'),
    label: z.string().max(64).optional(),
    inputs: z
      .number()
      .int()
      .min(MIN_GATE_INPUTS)
      .max(MAX_GATE_INPUTS)
      .optional()
      .describe('Только AND/NAND/OR/NOR/XOR/XNOR: число входов 2…8 (выводы A…H), по умолчанию 2'),
  }),
  set_gate_inputs: z.object({
    id: z.string().min(1).max(64),
    inputs: z.number().int().min(MIN_GATE_INPUTS).max(MAX_GATE_INPUTS).describe('Число входов 2…8 (выводы A…H)'),
  }),
  move_component: z.object({ id: z.string().min(1).max(64), x: z.number().finite(), y: z.number().finite() }),
  remove_component: z.object({ id: z.string().min(1).max(64) }),
  connect_pins: z.object({ from: pinRef, to: pinRef }),
  disconnect_pins: z.object({ from: pinRef, to: pinRef }),
  set_input: z.object({ id: z.string().min(1).max(64), value: z.union([z.literal(0), z.literal(1)]) }),
  set_word_sequence: z.object({
    words: z.array(word).max(MAX_WORDS).describe('16-битные слова; D0 — младший бит'),
  }),
  configure_word_generator: z.object({
    cycle: z.boolean().optional(),
    stepsPerSecond: z.number().min(0.1).max(1000).optional(),
  }),
  attach_analyzer_channel: z.object({
    channel: z.number().int().min(0).max(ANALYZER_CHANNELS - 1),
    target: pinRef.nullable().describe('Вывод или ID сети (= ID вывода-драйвера); null — отключить канал'),
    label: z.string().max(32).optional(),
  }),
  simulation_step: z.object({ count: z.number().int().min(1).max(MAX_STEPS_PER_CALL).default(1) }),
  simulation_reset: z.object({ clearHistory: z.boolean().default(true) }),
  simulation_run: z.object({}),
  simulation_stop: z.object({}),
  get_signal_values: z.object({
    ids: z.array(z.string().max(130)).max(1000).optional().describe('Выводы/сети; по умолчанию — все сети и выходы'),
  }),
  get_analyzer_history: z.object({
    channels: z.array(z.number().int().min(0).max(ANALYZER_CHANNELS - 1)).max(ANALYZER_CHANNELS).optional(),
    fromTick: z.number().int().min(0).optional(),
    toTick: z.number().int().min(0).optional(),
  }),
  get_validation_errors: z.object({}),
  undo: z.object({}),
  redo: z.object({}),
  export_analyzer_csv: z.object({ path: z.string().min(1).max(260).optional() }),
  save_project: z.object({ path: z.string().min(1).max(260).optional().describe('Путь относительно рабочей директории OpenBench') }),
  open_project: z.object({ path: z.string().min(1).max(260).describe('Путь относительно рабочей директории OpenBench') }),
} as const;

export type ApiMethod = keyof typeof API_SCHEMAS;
export const API_METHODS = Object.keys(API_SCHEMAS) as ApiMethod[];

export function parseWord(w: number | string): number {
  if (typeof w === 'number') return w;
  const v = w.startsWith('0x') ? parseInt(w.slice(2), 16) : w.startsWith('0b') ? parseInt(w.slice(2), 2) : parseInt(w, 10);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) fail('INVALID_ARGUMENT', `Слово "${w}" вне диапазона 0…0xFFFF`);
  return v;
}

export function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function signalsForChannel(frames: readonly Frame[], ch: number): (Signal | null)[] {
  return frames.map((f) => f.channels[ch] ?? null);
}

export function projectState(session: Session): Record<string, unknown> {
  const c = session.circuit;
  return {
    title: c.title,
    filePath: session.filePath,
    dirty: session.dirty,
    components: c.components.map((comp) => ({ ...comp, pins: componentPins(comp).map((p) => ({ id: p.id, direction: p.direction })) })),
    wires: c.wires.map((w) => ({ id: w.id, from: w.a, to: w.b })),
    junctions: c.junctions,
    nets: session.result.netlist.nets.map((n) => ({
      id: n.id,
      value: session.result.nets.get(n.id),
      drivers: n.drivers,
      sinks: n.sinks,
    })),
    wordGenerator: { ...c.instruments.wordGenerator, wordsHex: c.instruments.wordGenerator.words.map(hex4) },
    logicAnalyzer: {
      channels: c.instruments.logicAnalyzer.channels.map((ch, i) => {
        const la = c.components.find((x) => x.type === 'LOGIC_ANALYZER');
        const pin = la ? `${la.id}.CH${i}` : null;
        const net = pin ? session.result.netlist.netOfPin.get(pin) : undefined;
        return { channel: i, label: ch.label, visible: ch.visible, netId: net?.id ?? null };
      }),
      maxHistory: c.instruments.logicAnalyzer.maxHistory,
    },
    simulation: session.status(),
    diagnostics: session.diagnostics,
    canUndo: session.canUndo,
    canRedo: session.canRedo,
  };
}

export function analyzerCsv(session: Session): string {
  const labels = session.circuit.instruments.logicAnalyzer.channels.map((c) => c.label);
  const lines = [['tick', 'address', 'word', ...labels].join(',')];
  for (const f of session.history) {
    lines.push([f.tick, hex4(f.address), hex4(f.word), ...f.channels.map((s) => (s === null ? '' : String(s)))].join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Executes one API request against the session. Used by the GUI bridge host (requests
 * coming from the MCP server) and by tests. Throws OpenBenchError on failure; on failure
 * the project is unchanged (all edits are atomic).
 */
export async function handleApiRequest(
  session: Session,
  method: string,
  rawParams: unknown,
  files?: WorkspaceFiles,
): Promise<unknown> {
  if (!(method in API_SCHEMAS)) fail('INVALID_ARGUMENT', `Неизвестный метод ${method}`);
  const schema = API_SCHEMAS[method as ApiMethod];
  const parsed = schema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    throw new OpenBenchError(
      'INVALID_ARGUMENT',
      `Неверные параметры ${method}`,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const m = method as ApiMethod;
  switch (m) {
    case 'get_project_state':
      return projectState(session);
    case 'new_project': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['new_project']>;
      session.newProject(p.title);
      return { ok: true, title: session.circuit.title };
    }
    case 'add_component': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['add_component']>;
      const cmd: Parameters<Session['edit']>[0] = { type: 'addComponent', componentType: p.type, x: p.x, y: p.y };
      if (p.id !== undefined) cmd.id = p.id;
      if (p.label !== undefined) cmd.label = p.label;
      if (p.inputs !== undefined) cmd.inputs = p.inputs;
      return session.edit(cmd);
    }
    case 'set_gate_inputs': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['set_gate_inputs']>;
      return session.edit({ type: 'setComponentProps', id: p.id, inputs: p.inputs });
    }
    case 'move_component': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['move_component']>;
      session.edit({ type: 'moveItems', components: [{ id: p.id, x: p.x, y: p.y }] });
      const comp = session.circuit.components.find((c) => c.id === p.id)!;
      return { component: comp, pins: componentPins(comp) };
    }
    case 'remove_component': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['remove_component']>;
      return session.edit({ type: 'removeItems', componentIds: [p.id] });
    }
    case 'connect_pins': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['connect_pins']>;
      const r = session.edit({ type: 'connect', a: p.from, b: p.to });
      return { ...r, value: r.netId ? session.result.nets.get(r.netId as string) : null };
    }
    case 'disconnect_pins': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['disconnect_pins']>;
      return session.edit({ type: 'disconnect', a: p.from, b: p.to });
    }
    case 'set_input': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['set_input']>;
      session.setInput(p.id, p.value);
      return { id: p.id, value: p.value, output: session.result.pins.get(`${p.id}.OUT`) };
    }
    case 'set_word_sequence': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['set_word_sequence']>;
      const words = p.words.map(parseWord);
      session.edit({ type: 'setWords', words });
      return { count: words.length, wordsHex: words.map(hex4) };
    }
    case 'configure_word_generator': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['configure_word_generator']>;
      const cmd: Parameters<Session['edit']>[0] = { type: 'configureWordGenerator' };
      if (p.cycle !== undefined) cmd.cycle = p.cycle;
      if (p.stepsPerSecond !== undefined) cmd.stepsPerSecond = p.stepsPerSecond;
      const r = session.edit(cmd);
      session.restartIfRunning();
      return r;
    }
    case 'attach_analyzer_channel': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['attach_analyzer_channel']>;
      const r = session.edit({ type: 'attachAnalyzerChannel', channel: p.channel, target: p.target });
      if (p.label !== undefined) session.edit({ type: 'configureAnalyzer', channels: [{ index: p.channel, label: p.label }] });
      return r;
    }
    case 'simulation_step': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['simulation_step']>;
      const frames = session.step(p.count);
      return {
        executed: frames.length,
        frames: frames.map((f) => ({ tick: f.tick, address: f.address, word: hex4(f.word), channels: f.channels })),
        status: session.status(),
      };
    }
    case 'simulation_reset': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['simulation_reset']>;
      session.reset(p.clearHistory);
      return { status: session.status() };
    }
    case 'simulation_run':
      session.run();
      return { status: session.status() };
    case 'simulation_stop':
      session.stop();
      return { status: session.status() };
    case 'get_signal_values': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['get_signal_values']>;
      const res = session.result;
      if (!p.ids) {
        const outputs: Record<string, Signal> = {};
        for (const c of session.circuit.components) {
          if (c.type === 'OUTPUT') outputs[c.id] = res.pins.get(`${c.id}.IN`) ?? 'X';
        }
        return {
          nets: Object.fromEntries([...res.nets.entries()]),
          outputs,
          analyzer: Object.fromEntries(
            session.circuit.instruments.logicAnalyzer.channels.map((_, i) => {
              const la = session.circuit.components.find((x) => x.type === 'LOGIC_ANALYZER');
              const net = la ? res.netlist.netOfPin.get(`${la.id}.CH${i}`) : undefined;
              return [`CH${i}`, net ? res.nets.get(net.id)! : null];
            }),
          ),
          status: session.status(),
        };
      }
      const values: Record<string, Signal> = {};
      for (const id of p.ids) {
        if (res.nets.has(id)) values[id] = res.nets.get(id)!;
        else if (res.pins.has(id)) values[id] = res.pins.get(id)!;
        else {
          const comp = session.circuit.components.find((c) => c.id === id);
          if (comp?.type === 'OUTPUT') values[id] = res.pins.get(`${id}.IN`)!;
          else if (comp?.type === 'INPUT') values[id] = res.pins.get(`${id}.OUT`)!;
          else fail('INVALID_ID', `"${id}" не является выводом, сетью или INPUT/OUTPUT`);
        }
      }
      return { values, status: session.status() };
    }
    case 'get_analyzer_history': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['get_analyzer_history']>;
      const channels = p.channels ?? Array.from({ length: ANALYZER_CHANNELS }, (_, i) => i);
      const frames = session.history.filter((f) => (p.fromTick === undefined || f.tick >= p.fromTick) && (p.toTick === undefined || f.tick <= p.toTick));
      const labels = session.circuit.instruments.logicAnalyzer.channels;
      return {
        ticks: frames.map((f) => f.tick),
        words: frames.map((f) => hex4(f.word)),
        channels: Object.fromEntries(channels.map((ch) => [`CH${ch}`, { label: labels[ch]!.label, values: signalsForChannel(frames, ch) }])),
        droppedFrames: session.status().droppedFrames,
      };
    }
    case 'get_validation_errors':
      return { diagnostics: session.diagnostics };
    case 'undo':
      session.undo();
      return { canUndo: session.canUndo, canRedo: session.canRedo };
    case 'redo':
      session.redo();
      return { canUndo: session.canUndo, canRedo: session.canRedo };
    case 'export_analyzer_csv': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['export_analyzer_csv']>;
      const csv = analyzerCsv(session);
      if (!p.path) return { csv };
      if (!files) fail('FILE_ERROR', 'Файловый доступ недоступен в этом режиме');
      if (!p.path.toLowerCase().endsWith('.csv')) fail('PATH_NOT_ALLOWED', 'Файл должен иметь расширение .csv');
      const path = await files.write(p.path, csv);
      return { path, rows: session.history.length };
    }
    case 'save_project': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['save_project']>;
      if (!files) fail('FILE_ERROR', 'Файловый доступ недоступен в этом режиме');
      const rel = p.path ?? `${slug(session.circuit.title)}.openbench.json`;
      if (!rel.toLowerCase().endsWith('.openbench.json')) fail('PATH_NOT_ALLOWED', 'Файл проекта должен иметь расширение .openbench.json');
      const path = await files.write(rel, serializeCircuit(session.circuit));
      session.markSaved(path);
      return { path };
    }
    case 'open_project': {
      const p = parsed.data as z.infer<(typeof API_SCHEMAS)['open_project']>;
      if (!files) fail('FILE_ERROR', 'Файловый доступ недоступен в этом режиме');
      if (!p.path.toLowerCase().endsWith('.openbench.json')) fail('PATH_NOT_ALLOWED', 'Открывать можно только файлы .openbench.json');
      const { text, path } = await files.read(p.path);
      const circuit = parseProjectText(text);
      session.loadCircuit(circuit, path);
      return { path, title: circuit.title, components: circuit.components.length, wires: circuit.wires.length };
    }
  }
}

function slug(title: string): string {
  const s = title
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'project';
}
