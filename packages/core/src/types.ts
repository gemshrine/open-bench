export const GATE_TYPES = ['BUFFER', 'NOT', 'AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR'] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const COMPONENT_TYPES = [
  'INPUT',
  'OUTPUT',
  'CONST0',
  'CONST1',
  ...GATE_TYPES,
  'WORD_GENERATOR',
  'LOGIC_ANALYZER',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const WORD_BITS = 16;
export const ANALYZER_CHANNELS = 16;
export const MAX_WORDS = 1024;
export const MAX_STEPS_PER_CALL = 10000;
export const DEFAULT_MAX_HISTORY = 10000;

/**
 * Logic level of a net or pin.
 * - `0` / `1` — defined levels;
 * - `X` — unknown (no driver, unknown source, unresolved loop);
 * - `E` — error: conflicting drivers on one net.
 */
export type Signal = 0 | 1 | 'X' | 'E';

export type Bit = 0 | 1;

export interface Point {
  x: number;
  y: number;
}

export type PinDirection = 'input' | 'output';
export type PinSide = 'left' | 'right' | 'top' | 'bottom';

/** `<componentId>.<pinName>`, e.g. `and1.A`. */
export type PinId = string;

export interface Component {
  id: string;
  type: ComponentType;
  /** Top-left corner in canvas units. */
  x: number;
  y: number;
  label?: string;
  /** INPUT only: current manual level. */
  value?: Bit;
  /** INPUT only: keyboard key that toggles it (shown as `[key]`). */
  key?: string;
}

export interface Junction {
  id: string;
  x: number;
  y: number;
}

/**
 * Wire endpoint: either a pin id (`comp.PIN`, always contains a dot)
 * or a junction id (never contains a dot).
 */
export type Endpoint = string;

export interface Wire {
  id: string;
  a: Endpoint;
  b: Endpoint;
  /** Optional intermediate vertices; when absent the wire is routed automatically. */
  points?: Point[];
}

export interface WordGeneratorConfig {
  /** 16-bit words; bit 0 is D0. */
  words: number[];
  cycle: boolean;
  stepsPerSecond: number;
}

export interface AnalyzerChannelConfig {
  label: string;
  visible: boolean;
}

export interface LogicAnalyzerConfig {
  channels: AnalyzerChannelConfig[];
  maxHistory: number;
  clocksPerDivision: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Circuit {
  schemaVersion: 1;
  id: string;
  title: string;
  components: Component[];
  junctions: Junction[];
  wires: Wire[];
  instruments: {
    wordGenerator: WordGeneratorConfig;
    logicAnalyzer: LogicAnalyzerConfig;
  };
  viewport?: Viewport;
}

export function isPinEndpoint(e: Endpoint): boolean {
  return e.includes('.');
}

export function splitPinId(pin: PinId): { componentId: string; pin: string } {
  const i = pin.indexOf('.');
  return { componentId: pin.slice(0, i), pin: pin.slice(i + 1) };
}

export function isGateType(t: ComponentType): t is GateType {
  return (GATE_TYPES as readonly string[]).includes(t);
}
