import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProjectText, serializeCircuit } from '../src/schema.js';
import { Session } from '../src/session.js';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples');
const load = (name: string) => readFileSync(join(examples, name), 'utf8');

describe('shipped examples', () => {
  it.each([
    ['and-test.openbench.json', [0, 0, 0, 1]],
    ['xor-test.openbench.json', [0, 1, 1, 0]],
  ])('%s opens, re-serializes identically and gives CH0 = %j', (file, expected) => {
    const text = load(file);
    const circuit = parseProjectText(text);
    expect(serializeCircuit(circuit)).toBe(text);
    const s = new Session(circuit);
    s.step(4);
    expect(s.history.map((f) => f.channels[0])).toEqual(expected);
    expect(s.history.map((f) => f.channels[1])).toEqual([0, 1, 0, 1]);
    expect(s.history.map((f) => f.channels[2])).toEqual([0, 0, 1, 1]);
  });

  it('rs-latch.openbench.json sets, holds and resets', () => {
    const s = new Session(parseProjectText(load('rs-latch.openbench.json')));
    const q = () => s.result.pins.get('out1.IN');
    s.setInput('in1', 0);
    s.setInput('in2', 1);
    expect(q()).toBe(1);
    s.setInput('in1', 1);
    expect(q()).toBe(1);
    s.setInput('in2', 0);
    expect(q()).toBe(0);
    s.setInput('in2', 1);
    expect(q()).toBe(0);
  });
});
