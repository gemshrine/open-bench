import { describe, expect, it } from 'vitest';
import { componentBounds } from '../src/geometry.js';
import { buildNetlist } from '../src/netlist.js';
import { wirePolyline } from '../src/routing.js';
import type { Circuit, Point } from '../src/types.js';
import { newSession } from './helpers.js';

function crossesBody(c: Circuit, pts: Point[]): string[] {
  const hits: string[] = [];
  for (const comp of c.components) {
    const r = componentBounds(comp);
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      const x1 = Math.min(p.x, q.x);
      const x2 = Math.max(p.x, q.x);
      const y1 = Math.min(p.y, q.y);
      const y2 = Math.max(p.y, q.y);
      const hit =
        y1 === y2 ? y1 > r.y && y1 < r.y + r.height && x2 > r.x && x1 < r.x + r.width : x1 > r.x && x1 < r.x + r.width && y2 > r.y && y1 < r.y + r.height;
      if (hit) hits.push(comp.id);
    }
  }
  return hits;
}

function isOrthogonal(pts: Point[]): boolean {
  return pts.every((p, i) => i === 0 || p.x === pts[i - 1]!.x || p.y === pts[i - 1]!.y);
}

describe('auto routing', () => {
  it('forward connection is a simple H–V–H route', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'NOT', x: 100, y: 40 });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'not1.A' });
    const pts = wirePolyline(session.circuit, session.circuit.wires[0]!)!;
    expect(pts).toEqual([
      { x: 40, y: 10 },
      { x: 70, y: 10 },
      { x: 70, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it('does not run through component bodies when the target is behind the source', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'WORD_GENERATOR', x: 100, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'AND', x: 60, y: 120 });
    session.edit({ type: 'addComponent', componentType: 'LOGIC_ANALYZER', x: 400, y: -100 });
    session.edit({ type: 'connect', a: 'wg.D0', b: 'and1.A' });
    session.edit({ type: 'connect', a: 'wg.D1', b: 'and1.B' });
    session.edit({ type: 'connect', a: 'wg.D2', b: 'la.CH0' });
    session.edit({ type: 'connect', a: 'and1.OUT', b: 'la.CH3' });
    const routes = session.circuit.wires.map((w) => wirePolyline(session.circuit, w)!);
    for (const pts of routes) {
      expect(isOrthogonal(pts)).toBe(true);
      expect(crossesBody(session.circuit, pts)).toEqual([]);
    }
    // The two back-routed input wires must not share a vertical segment.
    const verticalXs = (pts: Point[]) => pts.slice(1).flatMap((p, i) => (p.x === pts[i]!.x ? [p.x] : []));
    const a = new Set(verticalXs(routes[0]!));
    const b = verticalXs(routes[1]!);
    expect(b.filter((x) => a.has(x))).toEqual([]);
  });

  it('wires of different nets never run on top of each other or over foreign pins', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'WORD_GENERATOR', x: 40, y: 20 });
    session.edit({ type: 'addComponent', componentType: 'AND', x: 140, y: 120 });
    session.edit({ type: 'addComponent', componentType: 'LOGIC_ANALYZER', x: 300, y: 20 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 240, y: 120 });
    session.edit({ type: 'connect', a: 'wg.D0', b: 'and1.A' });
    session.edit({ type: 'connect', a: 'wg.D1', b: 'and1.B' });
    session.edit({ type: 'connect', a: 'and1.OUT', b: 'out1.IN' });
    session.edit({ type: 'attachAnalyzerChannel', channel: 0, target: 'and1.OUT' });
    session.edit({ type: 'attachAnalyzerChannel', channel: 1, target: 'wg.D0' });
    session.edit({ type: 'attachAnalyzerChannel', channel: 2, target: 'wg.D1' });
    const c = session.circuit;
    const net = buildNetlist(c);
    const segs = c.wires.flatMap((w) => {
      const pts = wirePolyline(c, w)!;
      const id = net.netOfWire.get(w.id)!.id;
      return pts.slice(1).map((q, i) => ({ p: pts[i]!, q, net: id }));
    });
    for (const s1 of segs) {
      for (const s2 of segs) {
        if (s1.net === s2.net) continue;
        const sameRow = s1.p.y === s1.q.y && s2.p.y === s2.q.y && s1.p.y === s2.p.y;
        const sameCol = s1.p.x === s1.q.x && s2.p.x === s2.q.x && s1.p.x === s2.p.x;
        if (sameRow) {
          const overlap = Math.min(Math.max(s1.p.x, s1.q.x), Math.max(s2.p.x, s2.q.x)) - Math.max(Math.min(s1.p.x, s1.q.x), Math.min(s2.p.x, s2.q.x));
          expect(overlap, JSON.stringify([s1, s2])).toBeLessThanOrEqual(0);
        }
        if (sameCol) {
          const overlap = Math.min(Math.max(s1.p.y, s1.q.y), Math.max(s2.p.y, s2.q.y)) - Math.max(Math.min(s1.p.y, s1.q.y), Math.min(s2.p.y, s2.q.y));
          expect(overlap, JSON.stringify([s1, s2])).toBeLessThanOrEqual(0);
        }
      }
    }
    for (const w of c.wires) expect(crossesBody(c, wirePolyline(c, w)!)).toEqual([]);
  });
});

describe('routing around tall components', () => {
  it('a wire from the right to an input of an 8-input gate goes around the body, not through it', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'XOR', x: 400, y: 20, id: 'g', inputs: 8 });
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 520, y: 20, id: 'sw' });
    session.edit({ type: 'connect', a: 'sw.OUT', b: 'g.H' });
    const c = session.circuit;
    expect(crossesBody(c, wirePolyline(c, c.wires[0]!)!)).toEqual([]);
  });
});
