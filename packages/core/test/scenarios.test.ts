import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../src/api.js';
import { parseProjectText, serializeCircuit } from '../src/schema.js';
import { Session } from '../src/session.js';
import { channel, newSession } from './helpers.js';

function buildGateScenario(session: Session, gate: 'AND' | 'XOR'): void {
  session.edit({ type: 'addComponent', componentType: 'WORD_GENERATOR', x: 20, y: 20 });
  session.edit({ type: 'addComponent', componentType: gate, x: 200, y: 150 });
  session.edit({ type: 'addComponent', componentType: 'LOGIC_ANALYZER', x: 400, y: 20 });
  const g = gate.toLowerCase() + '1';
  session.edit({ type: 'connect', a: 'wg.D0', b: `${g}.A` });
  session.edit({ type: 'connect', a: 'wg.D1', b: `${g}.B` });
  session.edit({ type: 'connect', a: `${g}.OUT`, b: 'la.CH0' });
  session.edit({ type: 'attachAnalyzerChannel', channel: 1, target: 'wg.D0' });
  session.edit({ type: 'attachAnalyzerChannel', channel: 2, target: 'wg.D1' });
  session.edit({ type: 'setWords', words: [0x0000, 0x0001, 0x0002, 0x0003] });
}

describe('integration scenario 1: AND', () => {
  it('produces CH0=[0,0,0,1], CH1=[0,1,0,1], CH2=[0,0,1,1]', () => {
    const { session } = newSession();
    buildGateScenario(session, 'AND');
    for (let i = 0; i < 4; i++) session.step();
    expect(channel(session, 0)).toEqual([0, 0, 0, 1]);
    expect(channel(session, 1)).toEqual([0, 1, 0, 1]);
    expect(channel(session, 2)).toEqual([0, 0, 1, 1]);
    expect(channel(session, 3)).toEqual([null, null, null, null]);
    expect(session.history.map((f) => f.tick)).toEqual([0, 1, 2, 3]);
    expect(session.status().finished).toBe(true);
  });

  it('is deterministic regardless of component order', () => {
    const a = newSession().session;
    buildGateScenario(a, 'AND');
    const b = new Session({ ...a.circuit, components: [...a.circuit.components].reverse(), wires: [...a.circuit.wires].reverse() });
    a.step(4);
    b.step(4);
    expect(b.history).toEqual(a.history);
  });
});

describe('integration scenario 2: XOR', () => {
  it('produces CH0=[0,1,1,0]', () => {
    const { session } = newSession();
    buildGateScenario(session, 'XOR');
    session.step(4);
    expect(channel(session, 0)).toEqual([0, 1, 1, 0]);
  });
});

describe('integration scenario 3: save / open', () => {
  it('round-trips layout, wires, words, channels and simulation result', () => {
    const { session } = newSession();
    buildGateScenario(session, 'AND');
    session.edit({ type: 'moveItems', components: [{ id: 'and1', x: 230, y: 170 }] });
    session.edit({ type: 'configureWordGenerator', cycle: true, stepsPerSecond: 10 });
    session.edit({ type: 'configureAnalyzer', channels: [{ index: 0, label: 'Y' }] });
    const text = serializeCircuit(session.circuit);
    const reopened = new Session(parseProjectText(text));
    expect(reopened.circuit).toEqual(session.circuit);
    expect(serializeCircuit(reopened.circuit)).toBe(text);
    session.step(4);
    reopened.step(4);
    expect(reopened.history).toEqual(session.history);
  });

  it('rejects unsupported schemaVersion and malformed files without throwing generic errors', () => {
    expect(() => parseProjectText('{"schemaVersion":2}')).toThrowError(/версия/);
    expect(() => parseProjectText('not json')).toThrowError(/JSON/);
    expect(() => parseProjectText('{"schemaVersion":1,"id":"x"}')).toThrowError(/схеме/);
  });

  it('rejects dangling references', () => {
    const { session } = newSession();
    buildGateScenario(session, 'AND');
    const bad = JSON.parse(serializeCircuit(session.circuit));
    bad.wires.push({ id: 'wbad', a: 'nope.A', b: 'la.CH5' });
    expect(() => parseProjectText(JSON.stringify(bad))).toThrowError(/ссылок/);
  });
});

describe('api', () => {
  it('runs the AND scenario through the request handler', async () => {
    const { session } = newSession();
    const call = (m: string, p: unknown = {}) => handleApiRequest(session, m, p);
    await call('add_component', { type: 'WORD_GENERATOR', x: 0, y: 0 });
    const and = (await call('add_component', { type: 'AND', x: 200, y: 100 })) as { component: { id: string }; pins: { id: string }[] };
    expect(and.pins.map((p) => p.id)).toEqual(['and1.A', 'and1.B', 'and1.OUT']);
    await call('connect_pins', { from: 'wg.D0', to: 'and1.A' });
    await call('connect_pins', { from: 'wg.D1', to: 'and1.B' });
    await call('attach_analyzer_channel', { channel: 0, target: 'and1.OUT' });
    await call('set_word_sequence', { words: ['0x0000', 1, '0b10', 3] });
    const step = (await call('simulation_step', { count: 4 })) as { executed: number };
    expect(step.executed).toBe(4);
    const hist = (await call('get_analyzer_history', { channels: [0] })) as { channels: Record<string, { values: unknown[] }> };
    expect(hist.channels.CH0!.values).toEqual([0, 0, 0, 1]);
  });

  it('returns structured errors', async () => {
    const { session } = newSession();
    await expect(handleApiRequest(session, 'connect_pins', { from: 'x.A', to: 'y.B' })).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(handleApiRequest(session, 'add_component', { type: 'FOO', x: 0, y: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(handleApiRequest(session, 'simulation_step', { count: 100000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await handleApiRequest(session, 'set_word_sequence', { words: [] });
    await expect(handleApiRequest(session, 'simulation_step', {})).rejects.toMatchObject({ code: 'SEQUENCE_EMPTY' });
    await expect(handleApiRequest(session, 'save_project', {})).rejects.toMatchObject({ code: 'FILE_ERROR' });
  });
});
