import { footprint } from './geometry.js';
import { evalGate } from './logic.js';
import type { Net, Netlist } from './netlist.js';
import { buildNetlist } from './netlist.js';
import type { Circuit, Component, GateType, PinId, Signal } from './types.js';
import { ANALYZER_CHANNELS, WORD_BITS, isGateType } from './types.js';

export type DiagnosticCode =
  | 'DRIVER_CONFLICT'
  | 'NO_DRIVER'
  | 'UNCONNECTED_INPUT'
  | 'COMBINATIONAL_LOOP'
  | 'UNSTABLE_LOOP';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  componentIds?: string[];
  netId?: string;
}

export interface SourceInputs {
  /** Word currently presented by the Word Generator, or null if it has not output anything yet (all X). */
  word: number | null;
}

export interface EvalResult {
  netlist: Netlist;
  /** Value of every net by net id. */
  nets: Map<string, Signal>;
  /** Value of every pin (connected or not). */
  pins: Map<PinId, Signal>;
  diagnostics: Diagnostic[];
}

/**
 * Evaluates a combinational circuit.
 *
 * Gates are ordered by Tarjan's SCC algorithm over the gate dependency graph, so the
 * result never depends on the order of components in the array. Strongly connected
 * groups (combinational loops) are relaxed by synchronous iteration starting from the
 * previous net values (`prev`, or X); if they do not settle within a bounded number of
 * rounds their nets become X and an UNSTABLE_LOOP diagnostic is produced.
 */
export function evaluate(circuit: Circuit, sources: SourceInputs, prev?: Map<string, Signal>): EvalResult {
  const netlist = buildNetlist(circuit);
  const diagnostics: Diagnostic[] = [];
  const nets = new Map<string, Signal>();
  const pins = new Map<PinId, Signal>();

  // Output values of every driving pin.
  const outputs = new Map<PinId, Signal>();

  // 1. Sources.
  for (const c of circuit.components) {
    switch (c.type) {
      case 'INPUT':
        outputs.set(`${c.id}.OUT`, c.value ?? 0);
        break;
      case 'CONST0':
        outputs.set(`${c.id}.OUT`, 0);
        break;
      case 'CONST1':
        outputs.set(`${c.id}.OUT`, 1);
        break;
      case 'WORD_GENERATOR':
        for (let bit = 0; bit < WORD_BITS; bit++) {
          outputs.set(`${c.id}.D${bit}`, sources.word === null ? 'X' : (((sources.word >> bit) & 1) as 0 | 1));
        }
        break;
      default:
        break;
    }
  }

  // Conflicting nets are reported once.
  for (const net of netlist.nets) {
    if (net.drivers.length > 1) {
      diagnostics.push({
        code: 'DRIVER_CONFLICT',
        severity: 'error',
        message: `Сеть ${net.id}: несколько драйверов (${net.drivers.join(', ')})`,
        netId: net.id,
        componentIds: net.drivers.map((d) => d.split('.')[0]!),
      });
    } else if (net.drivers.length === 0 && net.sinks.length > 0) {
      diagnostics.push({
        code: 'NO_DRIVER',
        severity: 'warning',
        message: `Сеть ${net.id}: нет источника сигнала`,
        netId: net.id,
      });
    }
  }

  const netValue = (net: Net): Signal => {
    if (net.drivers.length > 1) return 'E';
    const d = net.drivers[0];
    if (d === undefined) return 'X';
    return outputs.get(d) ?? 'X';
  };
  const inputValue = (pin: PinId): Signal => {
    const net = netlist.netOfPin.get(pin);
    return net ? netValue(net) : 'X';
  };

  // 2. Gate dependency graph (structure cached per immutable circuit).
  const { gates, inputPins, deps, sccs } = gateGraph(circuit, netlist);

  const evalOne = (g: Component, i: number): Signal =>
    evalGate(
      g.type as GateType,
      inputPins[i]!.map((p) => inputValue(p)),
    );
  const indexOf = new Map(gates.map((g, i) => [g, i] as const));

  for (const scc of sccs) {
    const first = scc[0]!;
    const isLoop = scc.length > 1 || deps[first]!.includes(first);
    if (!isLoop) {
      const g = gates[first]!;
      outputs.set(`${g.id}.OUT`, evalOne(g, first));
      continue;
    }
    const members = scc.map((i) => gates[i]!).sort((a, b) => (a.id < b.id ? -1 : 1));
    const ids = members.map((m) => m.id);
    // Start from previous values of the loop's outputs (keeps latch state), else X.
    for (const g of members) {
      const pin = `${g.id}.OUT`;
      const net = netlist.netOfPin.get(pin);
      const p = net && prev ? prev.get(net.id) : undefined;
      outputs.set(pin, p === 0 || p === 1 ? p : 'X');
    }
    const maxRounds = 2 * members.length + 4;
    let stable = false;
    for (let round = 0; round < maxRounds; round++) {
      // Synchronous (Jacobi) update: order-independent and deterministic.
      const next = members.map((g) => evalOne(g, indexOf.get(g)!));
      let changed = false;
      members.forEach((g, i) => {
        const pin = `${g.id}.OUT`;
        if (outputs.get(pin) !== next[i]) {
          changed = true;
          outputs.set(pin, next[i]!);
        }
      });
      if (!changed) {
        stable = true;
        break;
      }
    }
    if (stable && members.some((g) => outputs.get(`${g.id}.OUT`) === 'X')) {
      // An X fixed point can hide an oscillator (e.g. a ring of inverters). Probe with a
      // definite seed and sequential (Gauss–Seidel) updates in ID order: a latch settles,
      // an oscillator never does. The probe only classifies; values stay X.
      const saved = members.map((g) => outputs.get(`${g.id}.OUT`)!);
      for (const g of members) outputs.set(`${g.id}.OUT`, 0);
      let settled = false;
      for (let round = 0; round < maxRounds && !settled; round++) {
        settled = true;
        for (const g of members) {
          const v = evalOne(g, indexOf.get(g)!);
          if (outputs.get(`${g.id}.OUT`) !== v) {
            outputs.set(`${g.id}.OUT`, v);
            settled = false;
          }
        }
      }
      members.forEach((g, i) => outputs.set(`${g.id}.OUT`, saved[i]!));
      if (!settled) stable = false;
    }
    if (stable) {
      diagnostics.push({
        code: 'COMBINATIONAL_LOOP',
        severity: 'warning',
        message: `Обратная связь (комбинационный цикл): ${ids.join(', ')}`,
        componentIds: ids,
      });
    } else {
      for (const g of members) outputs.set(`${g.id}.OUT`, 'X');
      diagnostics.push({
        code: 'UNSTABLE_LOOP',
        severity: 'error',
        message: `Неустойчивый цикл (генерация), выходы установлены в X: ${ids.join(', ')}`,
        componentIds: ids,
      });
    }
  }

  // 3. Collect net and pin values.
  for (const net of netlist.nets) nets.set(net.id, netValue(net));
  for (const c of circuit.components) {
    for (const p of footprint(c.type).pins) {
      const id = `${c.id}.${p.name}`;
      const net = netlist.netOfPin.get(id);
      if (p.direction === 'output') pins.set(id, net ? nets.get(net.id)! : (outputs.get(id) ?? 'X'));
      else pins.set(id, net ? nets.get(net.id)! : 'X');
    }
    if (isGateType(c.type) || c.type === 'OUTPUT') {
      const unconnected = footprint(c.type)
        .pins.filter((p) => p.direction === 'input' && !netlist.netOfPin.has(`${c.id}.${p.name}`))
        .map((p) => p.name);
      if (unconnected.length > 0) {
        diagnostics.push({
          code: 'UNCONNECTED_INPUT',
          severity: 'warning',
          message: `${c.id}: не подключены входы ${unconnected.join(', ')}`,
          componentIds: [c.id],
        });
      }
    }
  }
  return { netlist, nets, pins, diagnostics };
}

interface GateGraph {
  gates: Component[];
  inputPins: PinId[][];
  deps: number[][];
  sccs: number[][];
}

const graphCache = new WeakMap<Circuit, GateGraph>();

function gateGraph(circuit: Circuit, netlist: Netlist): GateGraph {
  const hit = graphCache.get(circuit);
  if (hit) return hit;
  const gates = circuit.components.filter((c) => isGateType(c.type)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const gateIndex = new Map(gates.map((g, i) => [g.id, i] as const));
  const inputPins = gates.map((g) =>
    footprint(g.type)
      .pins.filter((p) => p.direction === 'input')
      .map((p) => `${g.id}.${p.name}`),
  );
  const deps: number[][] = gates.map((_, gi) => {
    const out = new Set<number>();
    for (const pin of inputPins[gi]!) {
      const net = netlist.netOfPin.get(pin);
      if (!net) continue;
      for (const d of net.drivers) {
        const idx = gateIndex.get(d.split('.')[0]!);
        if (idx !== undefined) out.add(idx);
      }
    }
    return [...out].sort((a, b) => a - b);
  });
  const graph = { gates, inputPins, deps, sccs: tarjan(gates.length, deps) };
  graphCache.set(circuit, graph);
  return graph;
}

/** Values of analyzer channels CH0…CH15: null when the channel pin is not wired. */
export function analyzerChannelValues(circuit: Circuit, result: EvalResult): (Signal | null)[] {
  const la = circuit.components.find((c) => c.type === 'LOGIC_ANALYZER');
  return Array.from({ length: ANALYZER_CHANNELS }, (_, ch) => {
    if (!la) return null;
    const pin = `${la.id}.CH${ch}`;
    const net = result.netlist.netOfPin.get(pin);
    return net ? (result.nets.get(net.id) ?? 'X') : null;
  });
}

/** Iterative Tarjan SCC. Returns SCCs in reverse topological order (dependencies before dependents). */
function tarjan(n: number, deps: number[][]): number[][] {
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.v;
      const edges = deps[v]!;
      if (frame.i < edges.length) {
        const w = edges[frame.i++]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, i: 0 });
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low[parent.v] = Math.min(low[parent.v]!, low[v]!);
        if (low[v] === index[v]) {
          const scc: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = false;
            scc.push(w);
          } while (w !== v);
          result.push(scc.sort((a, b) => a - b));
        }
      }
    }
  }
  return result;
}
