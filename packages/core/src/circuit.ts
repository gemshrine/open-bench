import type { Circuit, ComponentType, LogicAnalyzerConfig, WordGeneratorConfig } from './types.js';
import { ANALYZER_CHANNELS, DEFAULT_MAX_HISTORY } from './types.js';
import { SCHEMA_VERSION } from './schema.js';

export function defaultWordGenerator(): WordGeneratorConfig {
  return { words: [0], cycle: false, stepsPerSecond: 4 };
}

export function defaultLogicAnalyzer(): LogicAnalyzerConfig {
  return {
    channels: Array.from({ length: ANALYZER_CHANNELS }, (_, i) => ({ label: `CH${i}`, visible: true })),
    maxHistory: DEFAULT_MAX_HISTORY,
    clocksPerDivision: 1,
  };
}

export function createCircuit(title = 'Без названия', id = 'project'): Circuit {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    components: [],
    junctions: [],
    wires: [],
    instruments: { wordGenerator: defaultWordGenerator(), logicAnalyzer: defaultLogicAnalyzer() },
  };
}

const ID_PREFIX: Record<ComponentType, string> = {
  INPUT: 'in',
  OUTPUT: 'out',
  CONST0: 'gnd',
  CONST1: 'vcc',
  BUFFER: 'buf',
  NOT: 'not',
  AND: 'and',
  NAND: 'nand',
  OR: 'or',
  NOR: 'nor',
  XOR: 'xor',
  XNOR: 'xnor',
  WORD_GENERATOR: 'wg',
  LOGIC_ANALYZER: 'la',
};

function usedIds(c: Circuit): Set<string> {
  return new Set([...c.components.map((x) => x.id), ...c.junctions.map((x) => x.id), ...c.wires.map((x) => x.id)]);
}

/** Next free readable ID with the given prefix: `and1`, `and2`, … (`wg`/`la` without a number when free). */
export function nextId(c: Circuit, prefix: string, bare = false): string {
  const used = usedIds(c);
  if (bare && !used.has(prefix)) return prefix;
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function nextComponentId(c: Circuit, type: ComponentType): string {
  return nextId(c, ID_PREFIX[type], type === 'WORD_GENERATOR' || type === 'LOGIC_ANALYZER');
}

/** First unused INPUT toggle key among 1…9, 0, a…z. */
export function nextInputKey(c: Circuit): string | undefined {
  const used = new Set(c.components.filter((x) => x.type === 'INPUT').map((x) => x.key));
  const keys = '1234567890abcdefghijklmnopqrstuvwxyz';
  for (const k of keys) if (!used.has(k)) return k;
  return undefined;
}
