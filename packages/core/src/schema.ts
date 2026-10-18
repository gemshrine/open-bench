import { z } from 'zod';
import { OpenBenchError } from './errors.js';
import { footprint, pinDef } from './geometry.js';
import type { Circuit } from './types.js';
import { ANALYZER_CHANNELS, COMPONENT_TYPES, MAX_GATE_INPUTS, MAX_WORDS, MIN_GATE_INPUTS, isMultiInputGateType, isPinEndpoint, splitPinId } from './types.js';

export const SCHEMA_VERSION = 1 as const;
export const FILE_EXTENSION = '.openbench.json';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'ID: латиница, цифры, "_" и "-"');
const coord = z.number().finite().min(-100000).max(100000);
const point = z.object({ x: coord, y: coord });
const endpoint = z.string().min(1).max(130);

export const ComponentSchema = z.object({
  id,
  type: z.enum(COMPONENT_TYPES),
  x: coord,
  y: coord,
  label: z.string().max(64).optional(),
  value: z.union([z.literal(0), z.literal(1)]).optional(),
  key: z.string().max(1).optional(),
  inputs: z.number().int().min(MIN_GATE_INPUTS).max(MAX_GATE_INPUTS).optional(),
});

export const JunctionSchema = z.object({ id, x: coord, y: coord });

export const WireSchema = z.object({
  id,
  a: endpoint,
  b: endpoint,
  points: z.array(point).max(256).optional(),
});

export const WordGeneratorSchema = z.object({
  words: z.array(z.number().int().min(0).max(0xffff)).max(MAX_WORDS),
  cycle: z.boolean(),
  stepsPerSecond: z.number().min(0.1).max(1000),
});

export const LogicAnalyzerSchema = z.object({
  channels: z
    .array(z.object({ label: z.string().max(32), visible: z.boolean() }))
    .length(ANALYZER_CHANNELS),
  maxHistory: z.number().int().min(16).max(1_000_000),
  clocksPerDivision: z.number().int().min(1).max(64),
});

export const CircuitSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id,
  title: z.string().max(200),
  components: z.array(ComponentSchema).max(10000),
  junctions: z.array(JunctionSchema).max(100000),
  wires: z.array(WireSchema).max(100000),
  instruments: z.object({
    wordGenerator: WordGeneratorSchema,
    logicAnalyzer: LogicAnalyzerSchema,
  }),
  viewport: z.object({ x: coord, y: coord, zoom: z.number().min(0.1).max(10) }).optional(),
});

/** Structural + referential validation. Returns a list of human-readable problems. */
export function checkCircuitReferences(c: Circuit): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const x of [...c.components, ...c.junctions, ...c.wires]) {
    if (ids.has(x.id)) problems.push(`Повторяющийся ID: ${x.id}`);
    ids.add(x.id);
  }
  const comps = new Map(c.components.map((x) => [x.id, x] as const));
  const junctions = new Set(c.junctions.map((j) => j.id));
  if (c.components.filter((x) => x.type === 'WORD_GENERATOR').length > 1) problems.push('Допускается один Word Generator');
  if (c.components.filter((x) => x.type === 'LOGIC_ANALYZER').length > 1) problems.push('Допускается один Logic Analyzer');
  for (const x of c.components)
    if (x.inputs !== undefined && !isMultiInputGateType(x.type)) problems.push(`${x.id} (${x.type}): число входов задаётся только вентилям AND/NAND/OR/NOR/XOR/XNOR`);
  for (const w of c.wires) {
    for (const e of [w.a, w.b]) {
      if (isPinEndpoint(e)) {
        const { componentId, pin } = splitPinId(e);
        const comp = comps.get(componentId);
        if (!comp) problems.push(`Провод ${w.id}: нет компонента ${componentId}`);
        else if (!pinDef(comp, pin))
          problems.push(`Провод ${w.id}: у ${componentId} (${comp.type}) нет вывода ${pin}; есть ${footprint(comp).pins.map((p) => p.name).join(', ')}`);
      } else if (!junctions.has(e)) {
        problems.push(`Провод ${w.id}: нет узла ${e}`);
      }
    }
    if (w.a === w.b) problems.push(`Провод ${w.id}: концы совпадают`);
  }
  return problems;
}

export function parseCircuit(data: unknown): Circuit {
  if (typeof data === 'object' && data !== null && 'schemaVersion' in data) {
    const v = (data as { schemaVersion: unknown }).schemaVersion;
    if (v !== SCHEMA_VERSION) {
      throw new OpenBenchError('SCHEMA_ERROR', `Неподдерживаемая версия формата: ${String(v)} (ожидается ${SCHEMA_VERSION})`);
    }
  }
  const parsed = CircuitSchema.safeParse(data);
  if (!parsed.success) {
    throw new OpenBenchError(
      'SCHEMA_ERROR',
      'Файл проекта не соответствует схеме OpenBench',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const circuit = parsed.data as Circuit;
  const problems = checkCircuitReferences(circuit);
  if (problems.length > 0) throw new OpenBenchError('SCHEMA_ERROR', 'Ошибки ссылок в проекте', problems);
  return circuit;
}

export function parseProjectText(text: string): Circuit {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new OpenBenchError('SCHEMA_ERROR', `Файл не является корректным JSON: ${(e as Error).message}`);
  }
  return parseCircuit(data);
}

/** Canonical, stable serialization (keys in schema order, 2-space indent, trailing newline). */
export function serializeCircuit(c: Circuit): string {
  const clean: Circuit = {
    schemaVersion: SCHEMA_VERSION,
    id: c.id,
    title: c.title,
    components: c.components.map((x) => {
      const o: Circuit['components'][number] = { id: x.id, type: x.type, x: x.x, y: x.y };
      if (x.label !== undefined) o.label = x.label;
      if (x.value !== undefined) o.value = x.value;
      if (x.key !== undefined) o.key = x.key;
      if (x.inputs !== undefined) o.inputs = x.inputs;
      return o;
    }),
    junctions: c.junctions.map((j) => ({ id: j.id, x: j.x, y: j.y })),
    wires: c.wires.map((w) => (w.points && w.points.length > 0 ? { id: w.id, a: w.a, b: w.b, points: w.points } : { id: w.id, a: w.a, b: w.b })),
    instruments: c.instruments,
  };
  if (c.viewport) clean.viewport = c.viewport;
  return JSON.stringify(clean, null, 2) + '\n';
}

export function projectJsonSchema(): unknown {
  return z.toJSONSchema(CircuitSchema);
}
