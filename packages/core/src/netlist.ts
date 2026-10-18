import { pinDef } from './geometry.js';
import type { Circuit, Endpoint, PinId } from './types.js';
import { isPinEndpoint, splitPinId } from './types.js';

export interface Net {
  /** Stable name: the driver pin id, or the smallest member pin id / junction id. */
  id: string;
  pins: PinId[];
  junctions: string[];
  drivers: PinId[];
  sinks: PinId[];
  wires: string[];
}

export interface Netlist {
  nets: Net[];
  netOfPin: Map<PinId, Net>;
  netOfJunction: Map<string, Net>;
  netOfWire: Map<string, Net>;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      if (ra < rb) this.parent.set(rb, ra);
      else this.parent.set(ra, rb);
    }
  }
}

export function pinDirection(circuit: Circuit, pin: PinId): 'input' | 'output' | undefined {
  const { componentId, pin: name } = splitPinId(pin);
  const c = circuit.components.find((x) => x.id === componentId);
  if (!c) return undefined;
  return pinDef(c.type, name)?.direction;
}

const cache = new WeakMap<Circuit, Netlist>();

/**
 * Builds electrical nets from wires (union-find over endpoints). Geometric crossings
 * never connect wires: only shared endpoints (pins or junctions) do.
 * Circuits are immutable, so the result is cached per circuit object (treat it as read-only).
 */
export function buildNetlist(circuit: Circuit): Netlist {
  const hit = cache.get(circuit);
  if (hit) return hit;
  const netlist = computeNetlist(circuit);
  cache.set(circuit, netlist);
  return netlist;
}

function computeNetlist(circuit: Circuit): Netlist {
  const uf = new UnionFind();
  const endpoints = new Set<Endpoint>();
  for (const w of circuit.wires) {
    endpoints.add(w.a);
    endpoints.add(w.b);
    uf.union(w.a, w.b);
  }
  const groups = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    const r = uf.find(e);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(e);
  }
  const directions = new Map<string, Map<string, 'input' | 'output'>>();
  for (const c of circuit.components) {
    const m = new Map<string, 'input' | 'output'>();
    directions.set(c.id, m);
  }
  const dirOf = (pin: PinId): 'input' | 'output' | undefined => {
    const { componentId, pin: name } = splitPinId(pin);
    const cache = directions.get(componentId);
    if (!cache) return undefined;
    let d = cache.get(name);
    if (d === undefined) {
      d = pinDirection(circuit, pin);
      if (d) cache.set(name, d);
    }
    return d;
  };

  const nets: Net[] = [];
  const netOfPin = new Map<PinId, Net>();
  const netOfJunction = new Map<string, Net>();
  for (const members of groups.values()) {
    members.sort();
    const pins = members.filter(isPinEndpoint);
    const junctions = members.filter((m) => !isPinEndpoint(m));
    const drivers = pins.filter((p) => dirOf(p) === 'output');
    const sinks = pins.filter((p) => dirOf(p) === 'input');
    const id = drivers[0] ?? pins[0] ?? junctions[0]!;
    const net: Net = { id, pins, junctions, drivers, sinks, wires: [] };
    nets.push(net);
    for (const p of pins) netOfPin.set(p, net);
    for (const j of junctions) netOfJunction.set(j, net);
  }
  const netOfWire = new Map<string, Net>();
  for (const w of circuit.wires) {
    const net = netOfPin.get(w.a) ?? netOfJunction.get(w.a);
    if (net) {
      net.wires.push(w.id);
      netOfWire.set(w.id, net);
    }
  }
  nets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { nets, netOfPin, netOfJunction, netOfWire };
}
