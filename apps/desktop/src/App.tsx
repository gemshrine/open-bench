import type { ComponentType } from '@openbench/core';
import { hex4, isOpenBenchError, parseProjectText, serializeCircuit } from '@openbench/core';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridgeStatus } from './bridge-host';
import type { Selection, View } from './canvas/Schematic';
import { EMPTY_SELECTION, Schematic } from './canvas/Schematic';
import { LogicAnalyzerWindow } from './instruments/LogicAnalyzerWindow';
import { WordGeneratorWindow } from './instruments/WordGeneratorWindow';
import { isTauri, openProjectFile, saveProjectAs, saveProjectTo } from './platform';
import { attempt, clearError, reportError, session, useLastError, useSessionVersion } from './store';
import { FloatingWindow } from './ui/FloatingWindow';
import { Palette } from './ui/Palette';
import { Properties } from './ui/Properties';

type WindowId = 'wg' | 'la';

export function App(): ReactElement {
  useSessionVersion();
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [placing, setPlacing] = useState<ComponentType | null>(null);
  const [view, setView] = useState<View>({ x: 20, y: 20, zoom: 1.5 });
  const [showGrid, setShowGrid] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [windows, setWindows] = useState<WindowId[]>([]);
  const [cancelToken, setCancelToken] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // Instruments open along the bottom edge (generator left, analyzer right), leaving the circuit visible.
  const instrumentPosition = (w: WindowId): { x: number; y: number } => {
    const r = workspaceRef.current?.getBoundingClientRect();
    const width = r?.width ?? 1000;
    const height = r?.height ?? 700;
    return w === 'wg' ? { x: 8, y: Math.max(8, height - 330) } : { x: Math.max(8, width - 418), y: Math.max(8, height - 418) };
  };
  const lastError = useLastError();
  const bridge = useBridgeStatus();
  const status = session.status();
  const circuit = session.circuit;

  // Drop selection entries that no longer exist (after undo, MCP edits, …).
  useEffect(() => {
    const comps = new Set(circuit.components.map((c) => c.id));
    const wires = new Set(circuit.wires.map((w) => w.id));
    const juncs = new Set(circuit.junctions.map((j) => j.id));
    const next = {
      components: selection.components.filter((id) => comps.has(id)),
      wires: selection.wires.filter((id) => wires.has(id)),
      junctions: selection.junctions.filter((id) => juncs.has(id)),
    };
    if (
      next.components.length !== selection.components.length ||
      next.wires.length !== selection.wires.length ||
      next.junctions.length !== selection.junctions.length
    )
      setSelection(next);
  }, [circuit, selection]);

  const openWindow = useCallback((w: WindowId) => setWindows((ws) => [...ws.filter((x) => x !== w), w]), []);
  const closeWindow = (w: WindowId) => setWindows((ws) => ws.filter((x) => x !== w));
  const toggleWindow = (w: WindowId) => (windows.includes(w) ? closeWindow(w) : openWindow(w));

  const confirmDiscard = () => !session.dirty || window.confirm('Текущий проект не сохранён. Продолжить без сохранения?');

  const doNew = () => {
    if (!confirmDiscard()) return;
    session.newProject();
    setSelection(EMPTY_SELECTION);
  };
  const doOpen = async () => {
    if (!confirmDiscard()) return;
    try {
      const f = await openProjectFile();
      if (!f) return;
      const c = parseProjectText(f.text);
      session.loadCircuit(c, f.path);
      if (c.viewport) setView(c.viewport);
      setSelection(EMPTY_SELECTION);
    } catch (e) {
      reportError(e);
    }
  };
  const doSave = async (as = false) => {
    try {
      const withView = { ...session.circuit, viewport: view };
      const text = serializeCircuit(withView);
      const name = `${session.circuit.title.replace(/[\\/:*?"<>|]+/g, '_') || 'project'}.openbench.json`;
      let path: string | null = session.filePath;
      if (as || !path || !isTauri) path = await saveProjectAs(path && isTauri ? path : name, text);
      else await saveProjectTo(path, text);
      if (path) session.markSaved(path);
    } catch (e) {
      reportError(e);
    }
  };

  const deleteSelection = () => {
    if (selection.components.length + selection.wires.length + selection.junctions.length === 0) return;
    attempt(() =>
      session.edit({ type: 'removeItems', componentIds: selection.components, wireIds: selection.wires.filter((id) => circuit.wires.some((w) => w.id === id)), junctionIds: selection.junctions }),
    );
    setSelection(EMPTY_SELECTION);
  };

  const runStop = () => attempt(() => (session.status().running ? session.stop() : session.run()));

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'z' && !e.shiftKey) attempt(() => session.undo());
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) attempt(() => session.redo());
    else if (ctrl && k === 's') void doSave(e.shiftKey);
    else if (ctrl && k === 'o') void doOpen();
    else if (ctrl && k === 'n') doNew();
    else if (ctrl && k === 'a')
      setSelection({ components: circuit.components.map((c) => c.id), wires: circuit.wires.map((w) => w.id), junctions: circuit.junctions.map((j) => j.id) });
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    else if (e.key === 'Escape') {
      setPlacing(null);
      setCancelToken((t) => t + 1);
      setSelection(EMPTY_SELECTION);
      clearError();
    } else if (e.key === 'F5') runStop();
    else if (e.key === 'F6') attempt(() => session.step(1));
    else if (e.key === 'F7') session.reset();
    else if (!ctrl && !e.altKey && /^[0-9a-z]$/.test(k)) {
      const sw = circuit.components.filter((c) => c.type === 'INPUT' && c.key === k);
      if (sw.length === 0) return;
      for (const c of sw) attempt(() => session.toggleInput(c.id));
    } else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Ask before closing the window (or the browser tab) with unsaved changes.
  useEffect(() => {
    if (!isTauri) {
      const h = (e: BeforeUnloadEvent) => {
        if (session.dirty) e.preventDefault();
      };
      window.addEventListener('beforeunload', h);
      return () => window.removeEventListener('beforeunload', h);
    }
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      unlisten = await getCurrentWindow().onCloseRequested((e) => {
        if (session.dirty && !window.confirm('Проект не сохранён. Закрыть OpenBench без сохранения?')) e.preventDefault();
      });
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const title = `${session.dirty ? '*' : ''}${circuit.title} — OpenBench`;
    document.title = title;
    if (isTauri) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => undefined);
    }
  });

  const zoomBy = (f: number) => setView((v) => ({ ...v, zoom: Math.min(6, Math.max(0.25, v.zoom * f)) }));

  return (
    <div className="app">
      <div className="toolbar" role="toolbar">
        <button onClick={doNew} title="Новый проект (Ctrl+N)">
          Новый
        </button>
        <button onClick={() => void doOpen()} title="Открыть (Ctrl+O)">
          Открыть…
        </button>
        <button onClick={() => void doSave(false)} title="Сохранить (Ctrl+S)" data-testid="save">
          Сохранить
        </button>
        <span className="sep" />
        <button onClick={() => attempt(() => session.undo())} disabled={!session.canUndo} title="Отменить (Ctrl+Z)">
          ↶ Отменить
        </button>
        <button onClick={() => attempt(() => session.redo())} disabled={!session.canRedo} title="Повторить (Ctrl+Y)">
          ↷ Повторить
        </button>
        <span className="sep" />
        <button onClick={runStop} className={status.running ? 'pressed' : ''} title="Пуск/пауза (F5)" data-testid="run">
          {status.running ? '❚❚ Пауза' : '▶ Пуск'}
        </button>
        <button onClick={() => attempt(() => session.step(1))} title="Один шаг (F6)" data-testid="step">
          Шаг
        </button>
        <button onClick={() => session.reset()} title="Сброс (F7): адрес 0000, tick 0, очистка истории" data-testid="reset">
          Сброс
        </button>
        <span className="sep" />
        <button onClick={() => zoomBy(1 / 1.25)} title="Уменьшить">
          −
        </button>
        <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
        <button onClick={() => zoomBy(1.25)} title="Увеличить">
          +
        </button>
        <span className="sep" />
        <button className={windows.includes('wg') ? 'pressed' : ''} onClick={() => toggleWindow('wg')} data-testid="open-wg">
          Word Generator
        </button>
        <button className={windows.includes('la') ? 'pressed' : ''} onClick={() => toggleWindow('la')} data-testid="open-la">
          Logic Analyzer
        </button>
        <span className="sep" />
        <label className="check">
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Сетка
        </label>
        <label className="check" title="Показывать логические уровни сетей цветом и подписью 0/1/X/E">
          <input type="checkbox" checked={showValues} onChange={(e) => setShowValues(e.target.checked)} data-testid="show-values" /> Уровни
        </label>
        <span className="spacer" />
        <button className={`power${status.running ? ' power-on' : ''}`} onClick={runStop} title="Включение/выключение моделирования (F5)" aria-label="Питание">
          <span className="power-o">O</span>
          <span className="power-knob" />
          <span className="power-i">I</span>
        </button>
      </div>
      <div className="main">
        <Palette placing={placing} onPick={setPlacing} />
        <div className="workspace" ref={workspaceRef}>
          <Schematic
            selection={selection}
            onSelect={setSelection}
            placing={placing}
            onPlaced={() => setPlacing(null)}
            view={view}
            onView={setView}
            showGrid={showGrid}
            showValues={showValues}
            onOpenInstrument={(t) => openWindow(t === 'WORD_GENERATOR' ? 'wg' : 'la')}
            cancelToken={cancelToken}
          />
          {windows.map((w, i) =>
            w === 'wg' ? (
              <FloatingWindow key="wg" title="Word Generator" initial={instrumentPosition('wg')} onClose={() => closeWindow('wg')} testId="wg-window" zIndex={10 + i} onFocus={() => windows.at(-1) !== 'wg' && openWindow('wg')}>
                <WordGeneratorWindow />
              </FloatingWindow>
            ) : (
              <FloatingWindow key="la" title="Logic Analyzer" initial={instrumentPosition('la')} onClose={() => closeWindow('la')} testId="la-window" zIndex={10 + i} onFocus={() => windows.at(-1) !== 'la' && openWindow('la')}>
                <LogicAnalyzerWindow />
              </FloatingWindow>
            ),
          )}
        </div>
        <Properties selection={selection} onSelectComponent={(id) => setSelection({ ...EMPTY_SELECTION, components: [id] })} />
      </div>
      <div className="statusbar">
        <span data-testid="status-tick">tick {status.tick}</span>
        <span title="Адрес слова на выходах Word Generator">адрес {status.currentAddress === null ? '----' : hex4(status.currentAddress)}</span>
        <span>слово {status.word === null ? 'XXXX' : hex4(status.word)}</span>
        <span>{status.running ? 'идёт моделирование' : status.finished ? 'конец последовательности' : 'остановлено'}</span>
        <span className="status-file" title={session.filePath ?? ''}>
          {session.filePath ? session.filePath.split(/[\\/]/).pop() : 'не сохранён'}
          {session.dirty ? ' *' : ''}
        </span>
        <span title={bridge.workspace ? `Рабочая папка MCP: ${bridge.workspace}` : ''}>
          {bridge.available ? `MCP: порт ${bridge.port}, клиентов ${bridge.clients}` : isTauri ? 'MCP: запуск…' : 'MCP: недоступен в браузере'}
        </span>
        {lastError && (
          <span className="status-error" data-testid="status-error" role="alert" onClick={clearError} title="Щёлкните, чтобы скрыть">
            ✖ {isOpenBenchError(lastError.error) ? `${lastError.error.message}` : lastError.error.message}
          </span>
        )}
      </div>
    </div>
  );
}
