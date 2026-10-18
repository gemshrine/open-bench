import { createCircuit } from './circuit.js';
import type { EditCommand } from './commands.js';
import { applyEdit } from './commands.js';
import { OpenBenchError, fail } from './errors.js';
import type { Diagnostic, EvalResult } from './simulate.js';
import { analyzerChannelValues, evaluate } from './simulate.js';
import type { Bit, Circuit, Signal } from './types.js';
import { MAX_STEPS_PER_CALL } from './types.js';

/** One Logic Analyzer sample, taken after the circuit has been evaluated for that tick. */
export interface Frame {
  tick: number;
  /** Word Generator address that was applied on this tick. */
  address: number;
  word: number;
  /** CH0…CH15; null = channel not connected. */
  channels: (Signal | null)[];
}

export interface SimulationStatus {
  tick: number;
  /** Address of the word that the next Step will apply. */
  address: number;
  /** Word currently on the generator outputs; null before the first step (outputs are X). */
  word: number | null;
  /** Address of the word currently on the outputs; null before the first step. */
  currentAddress: number | null;
  finished: boolean;
  running: boolean;
  historyLength: number;
  droppedFrames: number;
}

export type SessionEvent =
  | { kind: 'circuit' }
  | { kind: 'simulation' }
  | { kind: 'project' }
  | { kind: 'error'; error: OpenBenchError };

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

// Core is environment-neutral (no DOM/Node typings): access the standard timer functions structurally.
const host = globalThis as unknown as {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
};
const defaultTimers: Timers = {
  setInterval: (fn, ms) => host.setInterval(fn, ms),
  clearInterval: (h) => host.clearInterval(h),
};

const UNDO_LIMIT = 200;

/**
 * The single source of truth: project + simulation state.
 * Both the GUI and (through the bridge) the MCP server operate on one Session instance.
 *
 * Edits are applied synchronously between simulation ticks (JS is single-threaded), so
 * editing while Run is active is safe: the next tick simply sees the new circuit.
 */
export class Session {
  private _circuit: Circuit;
  private undoStack: Circuit[] = [];
  private redoStack: Circuit[] = [];
  private listeners = new Set<(e: SessionEvent) => void>();
  private timer: unknown = null;
  private readonly timers: Timers;

  dirty = false;
  filePath: string | null = null;
  /** Monotonic counter, bumped on every observable change (for UI subscriptions). */
  version = 0;

  private tick = 0;
  private address = 0;
  private currentAddress: number | null = null;
  private word: number | null = null;
  private finished = false;
  private running = false;
  private _history: Frame[] = [];
  private droppedFrames = 0;
  private _result: EvalResult;

  constructor(circuit: Circuit = createCircuit(), timers: Timers = defaultTimers) {
    this._circuit = circuit;
    this.timers = timers;
    this._result = evaluate(circuit, { word: null });
  }

  get circuit(): Circuit {
    return this._circuit;
  }

  get result(): EvalResult {
    return this._result;
  }

  get history(): readonly Frame[] {
    return this._history;
  }

  get diagnostics(): Diagnostic[] {
    return this._result.diagnostics;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: SessionEvent): void {
    this.version++;
    for (const l of [...this.listeners]) l(e);
  }

  private reevaluate(): void {
    this._result = evaluate(this._circuit, { word: this.word }, this._result.nets);
  }

  status(): SimulationStatus {
    return {
      tick: this.tick,
      address: this.address,
      word: this.word,
      currentAddress: this.currentAddress,
      finished: this.finished,
      running: this.running,
      historyLength: this._history.length,
      droppedFrames: this.droppedFrames,
    };
  }

  // ---------- editing ----------

  /** Applies an undoable edit. Throws OpenBenchError without changing anything on failure. */
  edit(cmd: EditCommand): Record<string, unknown> {
    const { circuit, result } = applyEdit(this._circuit, cmd);
    if (circuit === this._circuit) return result;
    if (cmd.type !== 'setViewport') {
      this.undoStack.push(this._circuit);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
    }
    this._circuit = circuit;
    this.afterCircuitChange();
    return result;
  }

  private afterCircuitChange(): void {
    const words = this._circuit.instruments.wordGenerator.words;
    if (words.length === 0) {
      this.address = 0;
    } else if (this.address >= words.length) {
      this.address = this._circuit.instruments.wordGenerator.cycle ? 0 : words.length - 1;
    }
    if (this.finished && words.length > 0 && this._circuit.instruments.wordGenerator.cycle) this.finished = false;
    this.reevaluate();
    this.emit({ kind: 'circuit' });
  }

  /** Manual INPUT values are not part of undo history (they are simulation controls). */
  private keepInputs(target: Circuit): Circuit {
    const current = new Map(this._circuit.components.filter((c) => c.type === 'INPUT').map((c) => [c.id, c.value] as const));
    return {
      ...target,
      components: target.components.map((c) => (c.type === 'INPUT' && current.has(c.id) ? { ...c, value: current.get(c.id)! } : c)),
    };
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) fail('NOTHING_TO_UNDO', 'Нечего отменять');
    this.redoStack.push(this._circuit);
    this._circuit = this.keepInputs(prev);
    this.dirty = true;
    this.afterCircuitChange();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) fail('NOTHING_TO_UNDO', 'Нечего повторять');
    this.undoStack.push(this._circuit);
    this._circuit = this.keepInputs(next);
    this.dirty = true;
    this.afterCircuitChange();
  }

  setInput(id: string, value: Bit): void {
    const comp = this._circuit.components.find((c) => c.id === id);
    if (!comp) fail('INVALID_ID', `Компонент "${id}" не найден`);
    if (comp.type !== 'INPUT') fail('INVALID_ARGUMENT', `${id} имеет тип ${comp.type}; set_input применяется только к INPUT`);
    if (value !== 0 && value !== 1) fail('INVALID_ARGUMENT', 'Значение INPUT: 0 или 1');
    if (comp.value === value) return;
    this._circuit = {
      ...this._circuit,
      components: this._circuit.components.map((c) => (c.id === id ? { ...c, value } : c)),
    };
    this.dirty = true;
    this.reevaluate();
    this.emit({ kind: 'circuit' });
  }

  toggleInput(id: string): void {
    const comp = this._circuit.components.find((c) => c.id === id);
    if (!comp) fail('INVALID_ID', `Компонент "${id}" не найден`);
    this.setInput(id, comp.value === 1 ? 0 : 1);
  }

  // ---------- project lifecycle ----------

  newProject(title?: string): void {
    this.stop();
    this._circuit = createCircuit(title);
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.filePath = null;
    this.resetSimulation(true, false);
    this.reevaluate();
    this.emit({ kind: 'project' });
  }

  loadCircuit(circuit: Circuit, filePath: string | null = null): void {
    this.stop();
    this._circuit = circuit;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.filePath = filePath;
    this.resetSimulation(true, false);
    this.reevaluate();
    this.emit({ kind: 'project' });
  }

  markSaved(filePath: string): void {
    this.filePath = filePath;
    this.dirty = false;
    this.emit({ kind: 'project' });
  }

  // ---------- simulation ----------

  /**
   * Executes `count` ticks. Each tick: apply the next Word Generator word (and current
   * manual INPUTs) → evaluate the circuit → record one Logic Analyzer frame → advance.
   * Without Cycle the sequence stops at its end (`finished`).
   */
  step(count = 1): Frame[] {
    if (!Number.isInteger(count) || count < 1) fail('INVALID_ARGUMENT', 'Число шагов должно быть целым ≥ 1');
    if (count > MAX_STEPS_PER_CALL) fail('LIMIT_EXCEEDED', `Не более ${MAX_STEPS_PER_CALL} шагов за вызов`);
    const wg = this._circuit.instruments.wordGenerator;
    if (wg.words.length === 0) fail('SEQUENCE_EMPTY', 'Последовательность Word Generator пуста: добавьте хотя бы одно слово');
    if (this.finished) fail('SEQUENCE_END', 'Достигнут конец последовательности. Включите Cycle или выполните Reset');
    const frames: Frame[] = [];
    for (let i = 0; i < count; i++) {
      const addr = this.address;
      const word = wg.words[addr]!;
      this.word = word;
      this.currentAddress = addr;
      this.reevaluate();
      const frame: Frame = { tick: this.tick, address: addr, word, channels: analyzerChannelValues(this._circuit, this._result) };
      this.pushFrame(frame);
      frames.push(frame);
      this.tick++;
      if (addr + 1 >= wg.words.length) {
        if (wg.cycle) this.address = 0;
        else {
          this.address = addr;
          this.finished = true;
          break;
        }
      } else {
        this.address = addr + 1;
      }
    }
    if (this.finished && this.running) this.stopTimer();
    this.emit({ kind: 'simulation' });
    return frames;
  }

  private pushFrame(f: Frame): void {
    this._history.push(f);
    const max = this._circuit.instruments.logicAnalyzer.maxHistory;
    if (this._history.length > max) {
      const extra = this._history.length - max;
      this._history.splice(0, extra);
      this.droppedFrames += extra;
    }
  }

  run(): void {
    if (this.running) return;
    const wg = this._circuit.instruments.wordGenerator;
    if (wg.words.length === 0) fail('SEQUENCE_EMPTY', 'Последовательность Word Generator пуста: добавьте хотя бы одно слово');
    if (this.finished) fail('SEQUENCE_END', 'Достигнут конец последовательности. Включите Cycle или выполните Reset');
    this.running = true;
    this.startTimer();
    this.emit({ kind: 'simulation' });
  }

  private startTimer(): void {
    const ms = Math.max(1, Math.round(1000 / this._circuit.instruments.wordGenerator.stepsPerSecond));
    this.timer = this.timers.setInterval(() => {
      try {
        this.step(1);
      } catch (e) {
        this.stop();
        if (e instanceof OpenBenchError) this.emit({ kind: 'error', error: e });
        else throw e;
      }
    }, ms);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /** Re-arm the timer after the playback rate has changed. */
  restartIfRunning(): void {
    if (!this.running) return;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.startTimer();
  }

  stop(): void {
    if (!this.running) return;
    this.stopTimer();
    this.emit({ kind: 'simulation' });
  }

  /**
   * Returns the sequence pointer and time to the beginning; generator outputs become X again.
   * `clearHistory` (default true) also clears the Logic Analyzer history.
   */
  reset(clearHistory = true): void {
    this.resetSimulation(clearHistory, true);
  }

  private resetSimulation(clearHistory: boolean, emit: boolean): void {
    this.stopTimer();
    this.tick = clearHistory ? 0 : this.tick;
    this.address = 0;
    this.currentAddress = null;
    this.word = null;
    this.finished = false;
    if (clearHistory) {
      this._history = [];
      this.droppedFrames = 0;
    }
    // Latch state inside loops is forgotten on reset.
    this._result = evaluate(this._circuit, { word: null });
    if (emit) this.emit({ kind: 'simulation' });
  }

  clearHistory(): void {
    this._history = [];
    this.droppedFrames = 0;
    this.emit({ kind: 'simulation' });
  }

  dispose(): void {
    this.stopTimer();
    this.listeners.clear();
  }
}
