import type { Circuit, Component, ComponentType, Endpoint, PinDirection, PinSide, Point } from './types.js';
import { ANALYZER_CHANNELS, WORD_BITS, isPinEndpoint, splitPinId } from './types.js';

export const GRID = 10;

export interface PinDef {
  name: string;
  direction: PinDirection;
  /** Offset from the component's top-left corner. */
  x: number;
  y: number;
  side: PinSide;
}

export interface Footprint {
  width: number;
  height: number;
  pins: PinDef[];
}

const twoInputGate: Footprint = {
  width: 40,
  height: 20,
  pins: [
    { name: 'A', direction: 'input', x: 0, y: 5, side: 'left' },
    { name: 'B', direction: 'input', x: 0, y: 15, side: 'left' },
    { name: 'OUT', direction: 'output', x: 40, y: 10, side: 'right' },
  ],
};

const oneInputGate: Footprint = {
  width: 40,
  height: 20,
  pins: [
    { name: 'A', direction: 'input', x: 0, y: 10, side: 'left' },
    { name: 'OUT', direction: 'output', x: 40, y: 10, side: 'right' },
  ],
};

/** Word Generator: D15…D8 then a gap then D7…D0 along the bottom edge (D0 rightmost). */
export function wordGeneratorPinX(bit: number): number {
  const i = WORD_BITS - 1 - bit;
  return 10 + i * 10 + (i >= 8 ? 10 : 0);
}

const wordGenerator: Footprint = {
  width: 190,
  height: 30,
  pins: Array.from({ length: WORD_BITS }, (_, bit) => ({
    name: `D${bit}`,
    direction: 'output' as const,
    x: wordGeneratorPinX(bit),
    y: 30,
    side: 'bottom' as const,
  })),
};

const logicAnalyzer: Footprint = {
  width: 40,
  height: 180,
  pins: Array.from({ length: ANALYZER_CHANNELS }, (_, ch) => ({
    name: `CH${ch}`,
    direction: 'input' as const,
    x: 0,
    y: 10 + ch * 10,
    side: 'left' as const,
  })),
};

export const FOOTPRINTS: Record<ComponentType, Footprint> = {
  INPUT: { width: 40, height: 20, pins: [{ name: 'OUT', direction: 'output', x: 40, y: 10, side: 'right' }] },
  OUTPUT: { width: 20, height: 20, pins: [{ name: 'IN', direction: 'input', x: 0, y: 10, side: 'left' }] },
  CONST1: { width: 30, height: 30, pins: [{ name: 'OUT', direction: 'output', x: 10, y: 30, side: 'bottom' }] },
  CONST0: { width: 20, height: 30, pins: [{ name: 'OUT', direction: 'output', x: 10, y: 0, side: 'top' }] },
  BUFFER: oneInputGate,
  NOT: oneInputGate,
  AND: twoInputGate,
  NAND: twoInputGate,
  OR: twoInputGate,
  NOR: twoInputGate,
  XOR: twoInputGate,
  XNOR: twoInputGate,
  WORD_GENERATOR: wordGenerator,
  LOGIC_ANALYZER: logicAnalyzer,
};

export function footprint(type: ComponentType): Footprint {
  return FOOTPRINTS[type];
}

export function pinDef(type: ComponentType, pin: string): PinDef | undefined {
  return FOOTPRINTS[type].pins.find((p) => p.name === pin);
}

export function pinPosition(c: Component, pin: PinDef): Point {
  return { x: c.x + pin.x, y: c.y + pin.y };
}

export interface EndpointGeometry {
  point: Point;
  /** Direction a wire leaves the endpoint; undefined for junctions. */
  side?: PinSide;
  /** Length of the straight lead-out before the first bend (pins only). */
  stub?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function endpointGeometry(circuit: Circuit, e: Endpoint): EndpointGeometry | undefined {
  if (isPinEndpoint(e)) {
    const { componentId, pin } = splitPinId(e);
    const c = circuit.components.find((x) => x.id === componentId);
    if (!c) return undefined;
    const def = pinDef(c.type, pin);
    if (!def) return undefined;
    // Pins on the same side get staggered lead-outs so that wires routed around the
    // component do not run on top of each other (which would look like a connection).
    const sameSide = FOOTPRINTS[c.type].pins.filter((p) => p.side === def.side);
    const rank = sameSide.length <= 4 ? sameSide.indexOf(def) : 0;
    return { point: pinPosition(c, def), side: def.side, stub: STUB + 5 * rank };
  }
  const j = circuit.junctions.find((x) => x.id === e);
  return j ? { point: { x: j.x, y: j.y } } : undefined;
}

const STUB = 10;

export function stubPoint(g: EndpointGeometry): Point {
  const p = g.point;
  const s = g.stub ?? STUB;
  switch (g.side) {
    case 'left':
      return { x: p.x - s, y: p.y };
    case 'right':
      return { x: p.x + s, y: p.y };
    case 'top':
      return { x: p.x, y: p.y - s };
    case 'bottom':
      return { x: p.x, y: p.y + s };
    default:
      return p;
  }
}

export function orthogonalize(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && prev.x !== p.x && prev.y !== p.y) {
      const before = out[out.length - 2];
      // Keep the direction of the previous segment where possible.
      if (before && before.x === prev.x) out.push({ x: prev.x, y: p.y });
      else out.push({ x: p.x, y: prev.y });
    }
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return simplify(out);
}

/** Remove collinear middle points. */
export function simplify(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1]!;
    const q = pts[i]!;
    const r = pts[i + 1]!;
    const collinear = (p.x === q.x && q.x === r.x) || (p.y === q.y && q.y === r.y);
    if (!collinear) out.push(q);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

export function snap(v: number, step = GRID): number {
  return Math.round(v / step) * step;
}

/** Distance from point to an axis-aligned or arbitrary segment. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Project a point onto the nearest segment of a polyline. */
export function projectOnPolyline(pts: Point[], p: Point): { point: Point; segment: number; distance: number } | undefined {
  let best: { point: Point; segment: number; distance: number } | undefined;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    let q: Point;
    if (a.x === b.x) q = { x: a.x, y: clamp(p.y, Math.min(a.y, b.y), Math.max(a.y, b.y)) };
    else if (a.y === b.y) q = { x: clamp(p.x, Math.min(a.x, b.x), Math.max(a.x, b.x)), y: a.y };
    else q = a;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (!best || d < best.distance) best = { point: q, segment: i, distance: d };
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function componentBounds(c: Component): { x: number; y: number; width: number; height: number } {
  const f = FOOTPRINTS[c.type];
  return { x: c.x, y: c.y, width: f.width, height: f.height };
}
