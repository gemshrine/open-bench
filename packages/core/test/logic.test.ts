import { describe, expect, it } from 'vitest';
import { evalGate } from '../src/logic.js';
import type { GateType, Signal } from '../src/types.js';

const TABLES: Record<Exclude<GateType, 'NOT' | 'BUFFER'>, [number, number, number][]> = {
  AND: [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 1],
  ],
  NAND: [
    [0, 0, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ],
  OR: [
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  NOR: [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 0],
  ],
  XOR: [
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ],
  XNOR: [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 1],
  ],
};

describe('truth tables', () => {
  for (const [gate, rows] of Object.entries(TABLES)) {
    for (const [a, b, out] of rows) {
      it(`${gate}(${a},${b}) = ${out}`, () => {
        expect(evalGate(gate as GateType, [a as Signal, b as Signal])).toBe(out);
      });
    }
  }
  it('NOT', () => {
    expect(evalGate('NOT', [0])).toBe(1);
    expect(evalGate('NOT', [1])).toBe(0);
  });
  it('BUFFER', () => {
    expect(evalGate('BUFFER', [0])).toBe(0);
    expect(evalGate('BUFFER', [1])).toBe(1);
  });
});

describe('X propagation', () => {
  it.each<[GateType, Signal[], Signal]>([
    ['AND', [0, 'X'], 0],
    ['AND', ['X', 0], 0],
    ['AND', [1, 'X'], 'X'],
    ['NAND', [0, 'X'], 1],
    ['NAND', [1, 'X'], 'X'],
    ['OR', [1, 'X'], 1],
    ['OR', [0, 'X'], 'X'],
    ['NOR', [1, 'X'], 0],
    ['NOR', [0, 'X'], 'X'],
    ['XOR', [0, 'X'], 'X'],
    ['XOR', [1, 'X'], 'X'],
    ['XNOR', [1, 'X'], 'X'],
    ['NOT', ['X'], 'X'],
    ['BUFFER', ['X'], 'X'],
    ['AND', [1, 'E'], 'X'],
    ['AND', [0, 'E'], 0],
    ['NOT', ['E'], 'X'],
  ])('%s(%j) = %s', (gate, inputs, out) => {
    expect(evalGate(gate, inputs)).toBe(out);
  });
});
