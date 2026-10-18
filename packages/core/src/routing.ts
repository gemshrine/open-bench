import type { EndpointGeometry, Rect } from './geometry.js';
import { componentBounds, endpointGeometry, footprint, orthogonalize, pinPosition, simplify, snap, stubPoint } from './geometry.js';
import { buildNetlist } from './netlist.js';
import type { Circuit, PinSide, Point, Wire } from './types.js';

/**
 * Automatic orthogonal wire routing.
 *
 * Wires are routed one after another in array order (deterministic). For each wire a set
 * of Manhattan candidates (straight, L, Z with several offsets, and the same with pin
 * lead-outs) is scored; the cheapest wins:
 *  - leaving/entering a pin against its direction, crossing a component body,
 *  - running on top of a wire of another net, or over another net's pin/junction
 *    (both would look like an electrical connection) are heavily penalised;
 *  - then fewer bends, shorter length and smaller offsets win.
 * Geometric crossings are allowed: they never connect anything.
 */

interface Seg {
  a: number;
  b: number;
  net: string;
}

class RouteContext {
  readonly obstacles: Rect[];
  /** Pins and junctions indexed by row (y) and column (x): [other coordinate, net key]. */
  private readonly rows = new Map<number, [number, string][]>();
  private readonly cols = new Map<number, [number, string][]>();
  private readonly horizontal = new Map<number, Seg[]>();
  private readonly vertical = new Map<number, Seg[]>();

  constructor(circuit: Circuit, netOf: (endpoint: string) => string) {
    this.obstacles = circuit.components.map(componentBounds);
    for (const c of circuit.components) {
      for (const p of footprint(c.type).pins) {
        const pos = pinPosition(c, p);
        this.addPoint(pos.x, pos.y, netOf(`${c.id}.${p.name}`));
      }
    }
    for (const j of circuit.junctions) this.addPoint(j.x, j.y, netOf(j.id));
  }

  private addPoint(x: number, y: number, net: string): void {
    pushPoint(this.rows, y, [x, net]);
    pushPoint(this.cols, x, [y, net]);
  }

  /** Obstacles near the bounding box of two points (cheap pre-filter). */
  near(p: Point, q: Point, margin = 80): Rect[] {
    const x1 = Math.min(p.x, q.x) - margin;
    const x2 = Math.max(p.x, q.x) + margin;
    const y1 = Math.min(p.y, q.y) - margin;
    const y2 = Math.max(p.y, q.y) + margin;
    return this.obstacles.filter((r) => r.x < x2 && r.x + r.width > x1 && r.y < y2 && r.y + r.height > y1);
  }

  occupy(path: Point[], net: string): void {
    for (let i = 0; i < path.length - 1; i++) {
      const p = path[i]!;
      const q = path[i + 1]!;
      if (p.y === q.y && p.x !== q.x) push(this.horizontal, p.y, { a: Math.min(p.x, q.x), b: Math.max(p.x, q.x), net });
      else if (p.x === q.x && p.y !== q.y) push(this.vertical, p.x, { a: Math.min(p.y, q.y), b: Math.max(p.y, q.y), net });
    }
  }

  /**
   * Conflict weight of a segment: overlaps with other nets' wires and other nets' pins or
   * junctions lying on it count 1; passing through a pin of the same net counts 0.4
   * (allowed, but a branch with a visible dot is preferred).
   */
  conflicts(p: Point, q: Point, net: string, ends: Set<string>): number {
    let n = 0;
    if (p.y === q.y) {
      const a = Math.min(p.x, q.x);
      const b = Math.max(p.x, q.x);
      for (const s of this.horizontal.get(p.y) ?? []) if (s.net !== net && Math.min(b, s.b) - Math.max(a, s.a) > 0) n++;
      for (const [x, owner] of this.rows.get(p.y) ?? []) if (x >= a && x <= b && !ends.has(`${x},${p.y}`)) n += owner === net ? 0.4 : 1;
    } else {
      const a = Math.min(p.y, q.y);
      const b = Math.max(p.y, q.y);
      for (const s of this.vertical.get(p.x) ?? []) if (s.net !== net && Math.min(b, s.b) - Math.max(a, s.a) > 0) n++;
      for (const [y, owner] of this.cols.get(p.x) ?? []) if (y >= a && y <= b && !ends.has(`${p.x},${y}`)) n += owner === net ? 0.4 : 1;
    }
    return n;
  }
}

function pushPoint(m: Map<number, [number, string][]>, k: number, v: [number, string]): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function push(m: Map<number, Seg[]>, k: number, s: Seg): void {
  const list = m.get(k);
  if (list) list.push(s);
  else m.set(k, [s]);
}

function direction(p: Point, q: Point): PinSide | undefined {
  if (q.x > p.x) return 'right';
  if (q.x < p.x) return 'left';
  if (q.y > p.y) return 'bottom';
  if (q.y < p.y) return 'top';
  return undefined;
}

/** True if an axis-aligned segment passes through the interior of the rectangle. */
function segmentHitsRect(p: Point, q: Point, r: Rect): boolean {
  const x1 = Math.min(p.x, q.x);
  const x2 = Math.max(p.x, q.x);
  const y1 = Math.min(p.y, q.y);
  const y2 = Math.max(p.y, q.y);
  if (y1 === y2) return y1 > r.y && y1 < r.y + r.height && x2 > r.x && x1 < r.x + r.width;
  return x1 > r.x && x1 < r.x + r.width && y2 > r.y && y1 < r.y + r.height;
}

const OFFSETS = [0, 5, -5, 10, -10, 15, -15, 20, -20, 30, -30];

function candidates(a: EndpointGeometry, b: EndpointGeometry): { inner: Point[]; offset: number }[] {
  const A = a.point;
  const B = b.point;
  const out: { inner: Point[]; offset: number }[] = [
    { inner: [], offset: 0 },
    { inner: [{ x: A.x, y: B.y }], offset: 0 },
    { inner: [{ x: B.x, y: A.y }], offset: 0 },
  ];
  const mx = snap((A.x + B.x) / 2, 5);
  const my = snap((A.y + B.y) / 2, 5);
  for (const k of OFFSETS) {
    out.push({ inner: [{ x: mx + k, y: A.y }, { x: mx + k, y: B.y }], offset: Math.abs(k) });
    out.push({ inner: [{ x: A.x, y: my + k }, { x: B.x, y: my + k }], offset: Math.abs(k) });
  }
  for (const ext of [0, 10, 20]) {
    const sa = stubPoint({ ...a, stub: (a.stub ?? 10) + ext });
    const sb = stubPoint({ ...b, stub: (b.stub ?? 10) + ext });
    out.push({ inner: [sa, { x: sa.x, y: sb.y }, sb], offset: ext });
    out.push({ inner: [sa, { x: sb.x, y: sa.y }, sb], offset: ext });
    const smx = snap((sa.x + sb.x) / 2, 5);
    const smy = snap((sa.y + sb.y) / 2, 5);
    for (const k of OFFSETS) {
      out.push({ inner: [sa, { x: smx + k, y: sa.y }, { x: smx + k, y: sb.y }, sb], offset: ext + Math.abs(k) });
      out.push({ inner: [sa, { x: sa.x, y: smy + k }, { x: sb.x, y: smy + k }, sb], offset: ext + Math.abs(k) });
    }
  }
  return out;
}

function cost(path: Point[], a: EndpointGeometry, b: EndpointGeometry, offset: number, ctx: RouteContext | null, net: string, obstacles: Rect[]): number {
  let c = offset * 0.3 + (path.length - 2) * 20;
  if (a.side && direction(path[0]!, path[1]!) !== a.side) c += 500;
  const n = path.length - 1;
  if (b.side && direction(path[n]!, path[n - 1]!) !== b.side) c += 500;
  const ends = new Set([`${path[0]!.x},${path[0]!.y}`, `${path[n]!.x},${path[n]!.y}`]);
  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    const q = path[i + 1]!;
    c += (Math.abs(q.x - p.x) + Math.abs(q.y - p.y)) * 0.05;
    if (ctx) {
      for (const r of obstacles) if (segmentHitsRect(p, q, r)) c += 1000;
      c += ctx.conflicts(p, q, net, ends) * 400;
    }
  }
  return c;
}

function bestRoute(a: EndpointGeometry, b: EndpointGeometry, ctx: RouteContext | null, net: string): Point[] {
  let best: Point[] = [a.point, b.point];
  let bestCost = Number.POSITIVE_INFINITY;
  const obstacles = ctx ? ctx.near(a.point, b.point) : [];
  for (const cand of candidates(a, b)) {
    const path = simplify(dedupe([a.point, ...cand.inner, b.point]));
    if (path.length < 2) continue;
    if (path.some((p, i) => i > 0 && p.x !== path[i - 1]!.x && p.y !== path[i - 1]!.y)) continue;
    const c = cost(path, a, b, cand.offset, ctx, net, obstacles);
    if (c < bestCost - 1e-9) {
      bestCost = c;
      best = path;
    }
  }
  return best;
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}

/** Route for a wire that is being drawn (no knowledge of the rest of the circuit needed). */
export function previewRoute(circuit: Circuit, a: EndpointGeometry, b: EndpointGeometry): Point[] {
  const ctx = new RouteContext(circuit, () => '');
  return bestRoute(a, b, ctx, '');
}

const cache = new WeakMap<Circuit, Map<string, Point[]>>();

/** Polylines (including endpoints) of all wires. Cached per immutable circuit object. */
export function routeAll(circuit: Circuit): Map<string, Point[]> {
  const hit = cache.get(circuit);
  if (hit) return hit;
  const netlist = buildNetlist(circuit);
  const netOf = (e: string): string => (netlist.netOfPin.get(e) ?? netlist.netOfJunction.get(e))?.id ?? `#${e}`;
  const ctx = new RouteContext(circuit, netOf);
  const result = new Map<string, Point[]>();
  for (const w of circuit.wires) {
    const pts = routeWire(circuit, w, ctx, netOf(w.a));
    if (!pts) continue;
    result.set(w.id, pts);
    ctx.occupy(pts, netOf(w.a));
  }
  cache.set(circuit, result);
  return result;
}

function routeWire(circuit: Circuit, w: Wire, ctx: RouteContext, net: string): Point[] | undefined {
  const a = endpointGeometry(circuit, w.a);
  const b = endpointGeometry(circuit, w.b);
  if (!a || !b) return undefined;
  if (w.points && w.points.length > 0) return orthogonalize([a.point, ...w.points, b.point]);
  return bestRoute(a, b, ctx, net);
}

/**
 * Polyline of one wire exactly as displayed. For a wire object that is not part of the
 * circuit (e.g. while merging), it is routed against the circuit as context.
 */
export function wirePolyline(circuit: Circuit, w: Wire): Point[] | undefined {
  if (circuit.wires.find((x) => x.id === w.id) === w) return routeAll(circuit).get(w.id);
  const netlist = buildNetlist(circuit);
  const netOf = (e: string): string => (netlist.netOfPin.get(e) ?? netlist.netOfJunction.get(e))?.id ?? `#${e}`;
  return routeWire(circuit, w, new RouteContext(circuit, netOf), netOf(w.a));
}

function onSegment(v: Point, p: Point, q: Point): boolean {
  if (p.x === q.x) return v.x === p.x && v.y >= Math.min(p.y, q.y) && v.y <= Math.max(p.y, q.y);
  if (p.y === q.y) return v.y === p.y && v.x >= Math.min(p.x, q.x) && v.x <= Math.max(p.x, q.x);
  return false;
}

/**
 * Points where wires of one net branch visually (a bend or end of one wire lying on another
 * wire of the same net). These get a junction dot, so a T-branch is never ambiguous.
 * Pin positions are excluded (several wires may start at the same pin).
 */
export function branchDots(circuit: Circuit): Point[] {
  const routes = routeAll(circuit);
  const netlist = buildNetlist(circuit);
  const pinPoints = new Set<string>();
  for (const c of circuit.components) for (const p of footprint(c.type).pins) {
    const pos = pinPosition(c, p);
    pinPoints.add(`${pos.x},${pos.y}`);
  }
  const dots = new Map<string, Point>();
  for (const net of netlist.nets) {
    if (net.wires.length < 2) continue;
    const polys = net.wires.map((id) => routes.get(id)).filter((p): p is Point[] => !!p);
    polys.forEach((poly, i) => {
      for (const v of poly) {
        const key = `${v.x},${v.y}`;
        if (pinPoints.has(key) || dots.has(key)) continue;
        const shared = polys.some((other, j) => j !== i && other.some((_, k) => k > 0 && onSegment(v, other[k - 1]!, other[k]!)));
        if (shared) dots.set(key, v);
      }
    });
  }
  return [...dots.values()];
}
