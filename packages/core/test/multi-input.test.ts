import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../src/api.js';
import { componentBounds, footprint } from '../src/geometry.js';
import { evalGate } from '../src/logic.js';
import { parseProjectText, serializeCircuit } from '../src/schema.js';
import type { Bit, GateType, Signal } from '../src/types.js';
import { MULTI_INPUT_GATE_TYPES } from '../src/types.js';
import { newSession } from './helpers.js';

const PINS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function reference(gate: GateType, bits: Bit[]): Bit {
  const ones = bits.filter((b) => b === 1).length;
  const and = ones === bits.length ? 1 : 0;
  const or = ones > 0 ? 1 : 0;
  const xor = (ones % 2) as Bit;
  const r = { AND: and, NAND: 1 - and, OR: or, NOR: 1 - or, XOR: xor, XNOR: 1 - xor }[gate as string];
  return r as Bit;
}

/** Gate with `n` inputs fed by INPUT switches in1…inN and an OUTPUT probe. */
function gateBench(gate: GateType, n: number) {
  const { session } = newSession();
  session.edit({ type: 'addComponent', componentType: gate, x: 200, y: 0, id: 'g', inputs: n });
  for (let i = 0; i < n; i++) {
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: i * 40, id: `s${i}` });
    session.edit({ type: 'connect', a: `s${i}.OUT`, b: `g.${PINS[i]}` });
  }
  session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 300, y: 0, id: 'probe' });
  session.edit({ type: 'connect', a: 'g.OUT', b: 'probe.IN' });
  return session;
}

describe('multi-input gates: footprint', () => {
  it('2 inputs keep the original 40×20 layout', () => {
    const f = footprint({ type: 'AND', inputs: 2 });
    expect(f).toBe(footprint('AND'));
    expect(f.pins.map((p) => [p.name, p.y])).toEqual([
      ['A', 5],
      ['B', 15],
      ['OUT', 10],
    ]);
  });

  it.each([3, 5, 8])('%i inputs: pins A… every 10 units, output centred, body grows', (n) => {
    const f = footprint({ type: 'NOR', inputs: n });
    expect(f.height).toBe(n * 10);
    expect(f.pins.filter((p) => p.direction === 'input').map((p) => p.name)).toEqual(PINS.slice(0, n));
    expect(f.pins.find((p) => p.name === 'OUT')!.y).toBe(n * 5);
    expect(componentBounds({ id: 'x', type: 'NOR', x: 0, y: 0, inputs: n }).height).toBe(n * 10);
  });
});

describe('multi-input gates: truth tables', () => {
  for (const gate of MULTI_INPUT_GATE_TYPES) {
    it(`${gate} with 3 inputs — all 8 combinations through the circuit`, () => {
      const session = gateBench(gate, 3);
      for (let v = 0; v < 8; v++) {
        const bits = [0, 1, 2].map((i) => ((v >> i) & 1) as Bit);
        bits.forEach((b, i) => session.setInput(`s${i}`, b));
        expect(session.result.pins.get('probe.IN'), `${gate}(${bits.join(',')})`).toBe(reference(gate, bits));
      }
    });

    it(`${gate} with 8 inputs — all 256 combinations`, () => {
      for (let v = 0; v < 256; v++) {
        const bits = Array.from({ length: 8 }, (_, i) => ((v >> i) & 1) as Bit);
        expect(evalGate(gate, bits)).toBe(reference(gate, bits));
      }
    });
  }

  it('8-input AND through the circuit', () => {
    const session = gateBench('AND', 8);
    for (let i = 0; i < 8; i++) session.setInput(`s${i}`, 1);
    expect(session.result.pins.get('probe.IN')).toBe(1);
    session.setInput('s7', 0);
    expect(session.result.pins.get('probe.IN')).toBe(0);
  });
});

describe('multi-input gates: X propagation', () => {
  const X: Signal = 'X';
  it.each([
    ['AND', [1, 1, 0, X], 0],
    ['AND', [1, 1, 1, X], X],
    ['NAND', [0, X, X, X], 1],
    ['OR', [0, 0, 1, X], 1],
    ['OR', [0, 0, 0, X], X],
    ['NOR', [X, 1, X], 0],
    ['XOR', [1, 1, 1, X], X],
    ['XNOR', [1, 0, 1, X, 0], X],
  ] as [GateType, Signal[], Signal][])('%s(%j) = %s', (gate, inputs, out) => {
    expect(evalGate(gate, inputs)).toBe(out);
  });

  it('an unconnected extra input gives X and a warning', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'CONST1', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'AND', x: 100, y: 0, inputs: 3 });
    session.edit({ type: 'connect', a: 'vcc1.OUT', b: 'and1.A' });
    session.edit({ type: 'connect', a: 'vcc1.OUT', b: 'and1.B' });
    expect(session.result.pins.get('and1.OUT')).toBe('X');
    expect(session.diagnostics.find((d) => d.code === 'UNCONNECTED_INPUT')?.message).toContain('C');
  });
});

describe('multi-input gates: editing', () => {
  it('changes the input count with undo/redo and keeps 2 as the implicit default', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'OR', x: 0, y: 0 });
    expect(session.circuit.components[0]!.inputs).toBeUndefined();
    const r = session.edit({ type: 'setComponentProps', id: 'or1', inputs: 4 });
    expect((r.pins as { id: string }[]).map((p) => p.id)).toEqual(['or1.A', 'or1.B', 'or1.C', 'or1.D', 'or1.OUT']);
    expect(session.circuit.components[0]!.inputs).toBe(4);
    session.undo();
    expect(session.circuit.components[0]!.inputs).toBeUndefined();
    session.redo();
    expect(session.circuit.components[0]!.inputs).toBe(4);
    session.edit({ type: 'setComponentProps', id: 'or1', inputs: 2 });
    expect(session.circuit.components[0]!.inputs).toBeUndefined();
  });

  it('refuses to shrink while a removed pin is wired, leaving the project unchanged', () => {
    const session = gateBench('XOR', 5);
    const before = session.circuit;
    expect(() => session.edit({ type: 'setComponentProps', id: 'g', inputs: 3 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONNECTION', details: { pins: ['g.D', 'g.E'] } }),
    );
    expect(session.circuit).toBe(before);
    session.edit({ type: 'removeItems', componentIds: ['s3', 's4'] });
    session.edit({ type: 'setComponentProps', id: 'g', inputs: 3 });
    expect(session.circuit.components.find((c) => c.id === 'g')!.inputs).toBe(3);
  });

  it('rejects out-of-range counts and gates with a fixed number of inputs', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'NAND', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'NOT', x: 0, y: 50 });
    for (const n of [1, 9, 2.5]) {
      expect(() => session.edit({ type: 'setComponentProps', id: 'nand1', inputs: n })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(() => session.edit({ type: 'setComponentProps', id: 'not1', inputs: 3 })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 100, inputs: 3 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => session.edit({ type: 'connect', a: 'nand1.C', b: 'not1.A' })).toThrowError(expect.objectContaining({ code: 'INVALID_ID' }));
  });
});

describe('multi-input gates: project file', () => {
  it('round-trips the input count and the wiring', () => {
    const session = gateBench('NAND', 6);
    const text = serializeCircuit(session.circuit);
    expect(text).toContain('"inputs": 6');
    const loaded = parseProjectText(text);
    expect(loaded).toEqual(JSON.parse(text));
    const { session: other } = newSession();
    other.loadCircuit(loaded);
    for (let i = 0; i < 6; i++) other.setInput(`s${i}`, 1);
    expect(other.result.pins.get('probe.IN')).toBe(0);
  });

  it('rejects files with wires to pins beyond the input count or inputs on other types', () => {
    const session = gateBench('AND', 3);
    const data = JSON.parse(serializeCircuit(session.circuit));
    data.components.find((c: { id: string }) => c.id === 'g').inputs = 2;
    expect(() => parseProjectText(JSON.stringify(data))).toThrowError(expect.objectContaining({ code: 'SCHEMA_ERROR' }));
    data.components.find((c: { id: string }) => c.id === 'g').inputs = 9;
    expect(() => parseProjectText(JSON.stringify(data))).toThrowError(expect.objectContaining({ code: 'SCHEMA_ERROR' }));
    data.components.find((c: { id: string }) => c.id === 'g').inputs = 3;
    data.components.find((c: { id: string }) => c.id === 'probe').inputs = 3;
    expect(() => parseProjectText(JSON.stringify(data))).toThrowError(expect.objectContaining({ code: 'SCHEMA_ERROR' }));
  });
});

describe('multi-input gates: API', () => {
  it('add_component with inputs returns all pin IDs; set_gate_inputs changes them', async () => {
    const { session } = newSession();
    const call = (m: string, p: unknown = {}) => handleApiRequest(session, m, p);
    const added = (await call('add_component', { type: 'OR', x: 0, y: 0, inputs: 3 })) as { pins: { id: string }[] };
    expect(added.pins.map((p) => p.id)).toEqual(['or1.A', 'or1.B', 'or1.C', 'or1.OUT']);
    const changed = (await call('set_gate_inputs', { id: 'or1', inputs: 8 })) as { pins: { id: string }[] };
    expect(changed.pins).toHaveLength(9);
    await expect(call('set_gate_inputs', { id: 'or1', inputs: 9 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(call('set_gate_inputs', { id: 'nope', inputs: 3 })).rejects.toMatchObject({ code: 'INVALID_ID' });
  });
});
