import { describe, expect, it } from 'vitest';
import { channel, newSession } from './helpers.js';

function wgToProbe() {
  const ctx = newSession();
  const { session } = ctx;
  session.edit({ type: 'addComponent', componentType: 'WORD_GENERATOR', x: 0, y: 0 });
  session.edit({ type: 'attachAnalyzerChannel', channel: 0, target: 'wg.D0' });
  session.edit({ type: 'setWords', words: [1, 0, 1] });
  return ctx;
}

describe('Word Generator', () => {
  it('outputs X before the first step and the applied word afterwards', () => {
    const { session } = wgToProbe();
    expect(session.result.pins.get('wg.D0')).toBe('X');
    session.step();
    expect(session.result.pins.get('wg.D0')).toBe(1);
    expect(session.status()).toMatchObject({ tick: 1, address: 1, currentAddress: 0, word: 1 });
  });

  it('stops at the end without Cycle', () => {
    const { session } = wgToProbe();
    const frames = session.step(10);
    expect(frames).toHaveLength(3);
    expect(session.status().finished).toBe(true);
    expect(() => session.step()).toThrowError(expect.objectContaining({ code: 'SEQUENCE_END' }));
  });

  it('wraps around with Cycle', () => {
    const { session } = wgToProbe();
    session.edit({ type: 'configureWordGenerator', cycle: true });
    session.step(7);
    expect(channel(session, 0)).toEqual([1, 0, 1, 1, 0, 1, 1]);
    expect(session.status().finished).toBe(false);
  });

  it('reset returns to the start and clears history', () => {
    const { session } = wgToProbe();
    session.step(2);
    session.reset();
    expect(session.status()).toMatchObject({ tick: 0, address: 0, word: null, historyLength: 0 });
    expect(session.result.pins.get('wg.D0')).toBe('X');
  });

  it('reset without clearing keeps history and continues the time axis', () => {
    const { session } = wgToProbe();
    session.step(2);
    session.reset(false);
    session.step(1);
    expect(session.history.map((f) => f.tick)).toEqual([0, 1, 2]);
  });

  it('empty sequence gives a clear error', () => {
    const { session } = wgToProbe();
    session.edit({ type: 'setWords', words: [] });
    expect(() => session.step()).toThrowError(expect.objectContaining({ code: 'SEQUENCE_EMPTY' }));
    expect(() => session.run()).toThrowError(expect.objectContaining({ code: 'SEQUENCE_EMPTY' }));
  });

  it('rejects words out of range', () => {
    const { session } = wgToProbe();
    expect(() => session.edit({ type: 'setWords', words: [0x10000] })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('Run executes one step per timer tick and stops at the end', () => {
    const { session, timers } = wgToProbe();
    session.run();
    expect(session.status().running).toBe(true);
    timers.fire(2);
    expect(session.history).toHaveLength(2);
    timers.fire(5);
    expect(session.history).toHaveLength(3);
    expect(session.status().running).toBe(false);
    expect(timers.active).toBe(0);
  });

  it('editing while running applies between ticks', () => {
    const { session, timers } = wgToProbe();
    session.edit({ type: 'configureWordGenerator', cycle: true });
    session.edit({ type: 'addComponent', componentType: 'NOT', x: 100, y: 100 });
    session.run();
    timers.fire(1);
    session.edit({ type: 'connect', a: 'wg.D0', b: 'not1.A' });
    session.edit({ type: 'attachAnalyzerChannel', channel: 1, target: 'not1.OUT' });
    timers.fire(2);
    session.stop();
    expect(channel(session, 1)).toEqual([null, 1, 0]);
  });
});

describe('Logic Analyzer', () => {
  it('limits history and reports dropped frames', () => {
    const { session } = wgToProbe();
    session.edit({ type: 'configureWordGenerator', cycle: true });
    session.edit({ type: 'configureAnalyzer', maxHistory: 16 });
    session.step(40);
    expect(session.history).toHaveLength(16);
    expect(session.status().droppedFrames).toBe(24);
    expect(session.history[0]!.tick).toBe(24);
  });

  it('reports null for unconnected channels', () => {
    const { session } = wgToProbe();
    session.step();
    expect(session.history[0]!.channels.slice(1).every((v) => v === null)).toBe(true);
  });

  it('auto-adds the analyzer when attaching the first channel', () => {
    const { session } = wgToProbe();
    expect(session.circuit.components.filter((c) => c.type === 'LOGIC_ANALYZER')).toHaveLength(1);
  });

  it('re-attaching a channel replaces the old connection', () => {
    const { session } = wgToProbe();
    session.edit({ type: 'attachAnalyzerChannel', channel: 0, target: 'wg.D1' });
    session.step();
    expect(session.history[0]!.channels[0]).toBe(0);
    session.edit({ type: 'attachAnalyzerChannel', channel: 0, target: null });
    session.step();
    expect(session.history[1]!.channels[0]).toBe(null);
  });
});

describe('performance', () => {
  it('100 gates × 1000 ticks completes quickly', () => {
    const { session } = newSession();
    session.edit({ type: 'addComponent', componentType: 'WORD_GENERATOR', x: 0, y: 0 });
    let prev = 'wg.D0';
    for (let i = 0; i < 100; i++) {
      const type = i % 2 === 0 ? 'XOR' : 'AND';
      session.edit({ type: 'addComponent', componentType: type, x: 100 + i * 50, y: 100 });
      const id = session.circuit.components[session.circuit.components.length - 1]!.id;
      session.edit({ type: 'connect', a: prev, b: `${id}.A` });
      session.edit({ type: 'connect', a: `wg.D${(i % 15) + 1}`, b: `${id}.B` });
      prev = `${id}.OUT`;
    }
    session.edit({ type: 'attachAnalyzerChannel', channel: 0, target: prev });
    session.edit({ type: 'setWords', words: Array.from({ length: 256 }, (_, i) => (i * 2654435761) & 0xffff) });
    session.edit({ type: 'configureWordGenerator', cycle: true });
    const t0 = performance.now();
    session.step(1000);
    const ms = performance.now() - t0;
    expect(session.history).toHaveLength(1000);
    console.log(`benchmark: 100 gates × 1000 ticks = ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(5000);
  });
});
