import { describe, expect, it } from 'vitest';
import { wirePolyline } from '../src/routing.js';
import { buildNetlist } from '../src/netlist.js';
import { evaluate } from '../src/simulate.js';
import { newSession } from './helpers.js';

describe('connections and nets', () => {
  it('allows fan-out from one output to several inputs', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'NOT', x: 100, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'BUFFER', x: 100, y: 50 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 200, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 200, y: 50 });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'not1.A' });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'buf1.A' });
    session.edit({ type: 'connect', a: 'not1.OUT', b: 'out1.IN' });
    session.edit({ type: 'connect', a: 'buf1.OUT', b: 'out2.IN' });
    expect(session.result.pins.get('out1.IN')).toBe(1);
    expect(session.result.pins.get('out2.IN')).toBe(0);
    session.setInput('in1', 1);
    expect(session.result.pins.get('out1.IN')).toBe(0);
    expect(session.result.pins.get('out2.IN')).toBe(1);
    const net = buildNetlist(session.circuit).netOfPin.get('in1.OUT')!;
    expect(net.id).toBe('in1.OUT');
    expect(net.sinks).toEqual(['buf1.A', 'not1.A']);
  });

  it('rejects connecting two outputs (driver conflict) and leaves the project unchanged', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'CONST0', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'CONST1', x: 50, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'AND', x: 100, y: 0 });
    session.edit({ type: 'connect', a: 'gnd1.OUT', b: 'and1.A' });
    const before = session.circuit;
    expect(() => session.edit({ type: 'connect', a: 'vcc1.OUT', b: 'and1.A' })).toThrowError(expect.objectContaining({ code: 'DRIVER_CONFLICT' }));
    expect(() => session.edit({ type: 'connect', a: 'vcc1.OUT', b: 'gnd1.OUT' })).toThrowError(expect.objectContaining({ code: 'DRIVER_CONFLICT' }));
    expect(session.circuit).toBe(before);
  });

  it('marks conflicting drivers loaded from a file as E', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'CONST0', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'CONST1', x: 50, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 100, y: 0 });
    session.edit({ type: 'connect', a: 'gnd1.OUT', b: 'out1.IN' });
    const forged = { ...session.circuit, wires: [...session.circuit.wires, { id: 'wx', a: 'vcc1.OUT', b: 'out1.IN' }] };
    const r = evaluate(forged, { word: null });
    expect(r.pins.get('out1.IN')).toBe('E');
    expect(r.diagnostics.some((d) => d.code === 'DRIVER_CONFLICT')).toBe(true);
  });

  it('gives X for a missing driver and unconnected inputs', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'AND', x: 100, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OR', x: 100, y: 50 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 200, y: 0 });
    session.edit({ type: 'connect', a: 'and1.A', b: 'or1.A' }); // input–input: no driver
    session.edit({ type: 'connect', a: 'and1.OUT', b: 'out1.IN' });
    expect(session.result.pins.get('and1.A')).toBe('X');
    expect(session.result.pins.get('out1.IN')).toBe('X');
    expect(session.diagnostics.map((d) => d.code)).toContain('NO_DRIVER');
    expect(session.diagnostics.map((d) => d.code)).toContain('UNCONNECTED_INPUT');
  });

  it('wires crossing geometrically are not connected', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'CONST1', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'CONST0', x: 100, y: 100 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 200, y: 60 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 60, y: 200 });
    session.edit({ type: 'connect', a: 'vcc1.OUT', b: 'out2.IN' });
    session.edit({ type: 'connect', a: 'gnd1.OUT', b: 'out1.IN' });
    expect(session.result.pins.get('out1.IN')).toBe(0);
    expect(session.result.pins.get('out2.IN')).toBe(1);
  });

  it('splits a wire with a junction (T-connection) and merges it back on delete', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 200, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 200, y: 100 });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'out1.IN' });
    const shape = wirePolyline(session.circuit, session.circuit.wires[0]!);
    const r = session.edit({ type: 'connect', a: { wireId: 'w1', x: 100, y: 12 }, b: 'out2.IN' });
    expect(r.junctionIds).toEqual(['j1']);
    expect(session.circuit.junctions[0]).toMatchObject({ x: 100, y: 10 });
    expect(session.circuit.wires).toHaveLength(3);
    session.setInput('in1', 1);
    expect(session.result.pins.get('out1.IN')).toBe(1);
    expect(session.result.pins.get('out2.IN')).toBe(1);
    const branch = session.circuit.wires.find((w) => w.b === 'out2.IN')!;
    session.edit({ type: 'removeItems', wireIds: [branch.id] });
    expect(session.circuit.junctions).toHaveLength(0);
    expect(session.circuit.wires).toHaveLength(1);
    expect(wirePolyline(session.circuit, session.circuit.wires[0]!)).toEqual(shape);
  });

  it('removing a component removes its wires', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'NOT', x: 100, y: 0 });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'not1.A' });
    session.edit({ type: 'removeItems', componentIds: ['not1'] });
    expect(session.circuit.wires).toHaveLength(0);
  });

  it('rejects unknown pins with a helpful list', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'AND', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 100, y: 0 });
    expect(() => session.edit({ type: 'connect', a: 'and1.C', b: 'out1.IN' })).toThrowError(/and1\.A, and1\.B, and1\.OUT/);
  });
});

describe('combinational loops', () => {
  it('detects an unstable ring oscillator and does not hang', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'NOT', x: 0, y: 0 });
    session.edit({ type: 'connect', a: 'not1.OUT', b: 'not1.A' });
    expect(session.result.pins.get('not1.OUT')).toBe('X');
    expect(session.diagnostics.some((d) => d.code === 'UNSTABLE_LOOP')).toBe(true);
  });

  it('resolves a NAND RS latch from set/reset and holds state', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 0 }); // S̄
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 100 }); // R̄
    session.edit({ type: 'addComponent', componentType: 'NAND', x: 100, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'NAND', x: 100, y: 100 });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'nand1.A' });
    session.edit({ type: 'connect', a: 'in2.OUT', b: 'nand2.B' });
    session.edit({ type: 'connect', a: 'nand1.OUT', b: 'nand2.A' });
    session.edit({ type: 'connect', a: 'nand2.OUT', b: 'nand1.B' });
    // S̄=0, R̄=0 → both 1 (forbidden but stable)
    expect(session.result.pins.get('nand1.OUT')).toBe(1);
    session.setInput('in2', 1); // S̄=0, R̄=1 → Q=1
    expect(session.result.pins.get('nand1.OUT')).toBe(1);
    expect(session.result.pins.get('nand2.OUT')).toBe(0);
    session.setInput('in1', 1); // hold
    expect(session.result.pins.get('nand1.OUT')).toBe(1);
    expect(session.result.pins.get('nand2.OUT')).toBe(0);
    session.setInput('in2', 0); // reset → Q=0
    expect(session.result.pins.get('nand1.OUT')).toBe(0);
    session.setInput('in2', 1); // hold
    expect(session.result.pins.get('nand1.OUT')).toBe(0);
    expect(session.diagnostics.some((d) => d.code === 'COMBINATIONAL_LOOP')).toBe(true);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes edits but not input toggles', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'INPUT', x: 0, y: 0 });
    session.edit({ type: 'addComponent', componentType: 'OUTPUT', x: 100, y: 0 });
    session.edit({ type: 'connect', a: 'in1.OUT', b: 'out1.IN' });
    session.setInput('in1', 1);
    session.undo();
    expect(session.circuit.wires).toHaveLength(0);
    expect(session.circuit.components.find((c) => c.id === 'in1')!.value).toBe(1);
    session.redo();
    expect(session.result.pins.get('out1.IN')).toBe(1);
    session.undo();
    session.undo();
    session.undo();
    expect(session.circuit.components).toHaveLength(0);
    expect(() => session.undo()).toThrowError(expect.objectContaining({ code: 'NOTHING_TO_UNDO' }));
  });
});
