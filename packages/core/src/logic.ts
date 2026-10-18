import type { GateType, Signal } from './types.js';

/**
 * Three-valued gate logic. `E` (driver conflict) on an input behaves like `X`.
 *
 * Propagation rules:
 * - AND: any 0 → 0; all 1 → 1; otherwise X.  (0 AND X = 0, 1 AND X = X)
 * - OR:  any 1 → 1; all 0 → 0; otherwise X.  (1 OR X = 1, 0 OR X = X)
 * - XOR: any X → X; otherwise parity.
 * - NOT/BUFFER: X → X.
 * - NAND/NOR/XNOR are negations of the above (NOT X = X).
 */
export function not(s: Signal): Signal {
  if (s === 0) return 1;
  if (s === 1) return 0;
  return 'X';
}

function and(inputs: Signal[]): Signal {
  let unknown = false;
  for (const s of inputs) {
    if (s === 0) return 0;
    if (s !== 1) unknown = true;
  }
  return unknown ? 'X' : 1;
}

function or(inputs: Signal[]): Signal {
  let unknown = false;
  for (const s of inputs) {
    if (s === 1) return 1;
    if (s !== 0) unknown = true;
  }
  return unknown ? 'X' : 0;
}

function xor(inputs: Signal[]): Signal {
  let acc = 0;
  for (const s of inputs) {
    if (s !== 0 && s !== 1) return 'X';
    acc ^= s;
  }
  return acc as 0 | 1;
}

export function evalGate(type: GateType, inputs: Signal[]): Signal {
  switch (type) {
    case 'BUFFER':
      return inputs[0] === 0 || inputs[0] === 1 ? inputs[0] : 'X';
    case 'NOT':
      return not(inputs[0] ?? 'X');
    case 'AND':
      return and(inputs);
    case 'NAND':
      return not(and(inputs));
    case 'OR':
      return or(inputs);
    case 'NOR':
      return not(or(inputs));
    case 'XOR':
      return xor(inputs);
    case 'XNOR':
      return not(xor(inputs));
  }
}

export function signalToString(s: Signal | null): string {
  return s === null ? '—' : String(s);
}
