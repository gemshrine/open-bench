import type { Circuit, Component, ComponentType, EndpointSpec, Point, Signal } from '@openbench/core';
import {
  applyEdit,
  componentBounds,
  distToSegment,
  endpointGeometry,
  footprint,
  pinPosition,
  branchDots,
  previewRoute,
  projectOnPolyline,
  routeAll,
  snap,
} from '@openbench/core';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attempt, session, useSessionVersion } from '../store';
import { ComponentLabel, ComponentSymbol, INK, SELECTED } from './symbols';

export interface Selection {
  components: string[];
  wires: string[];
  junctions: string[];
}

export const EMPTY_SELECTION: Selection = { components: [], wires: [], junctions: [] };

export interface View {
  x: number;
  y: number;
  zoom: number;
}

interface Props {
  selection: Selection;
  onSelect: (s: Selection) => void;
  placing: ComponentType | null;
  onPlaced: () => void;
  view: View;
  onView: (v: View) => void;
  showGrid: boolean;
  showValues: boolean;
  onOpenInstrument: (type: 'WORD_GENERATOR' | 'LOGIC_ANALYZER') => void;
  /** Bumped by the app to cancel the current interaction (Esc). */
  cancelToken: number;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'drag'; start: Point; moved: boolean; delta: Point }
  | { kind: 'wire'; from: EndpointSpec; fromPoint: Point; sticky: boolean; moved: boolean; downAt: Point }
  | { kind: 'wirePending'; wireId: string; at: Point; downAt: Point }
  | { kind: 'rubber'; start: Point; current: Point }
  | { kind: 'pan'; startScreen: Point; startView: View };

type Hit =
  | { kind: 'pin'; id: string; point: Point }
  | { kind: 'junction'; id: string; point: Point }
  | { kind: 'wire'; id: string; point: Point }
  | { kind: 'component'; id: string }
  | { kind: 'none' };

const VALUE_COLORS: Record<string, string> = { '1': '#c01818', '0': '#1f4fbf', X: '#8a8a8a', E: '#e08000' };

export function Schematic(props: Props): ReactElement {
  const { selection, onSelect, placing, onPlaced, view, onView, showGrid, showValues, onOpenInstrument, cancelToken } = props;
  useSessionVersion();
  const circuit = session.circuit;
  const result = session.result;
  const status = session.status();
  const svgRef = useRef<SVGSVGElement>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [hover, setHover] = useState<Hit>({ kind: 'none' });

  useEffect(() => {
    setMode({ kind: 'idle' });
  }, [cancelToken]);

  // Canvas → screen mapping for e2e tests (pins have no DOM elements of their own).
  useEffect(() => {
    if (!window.__openbench) return;
    window.__openbench.toScreen = (p: Point) => {
      const rect = svgRef.current!.getBoundingClientRect();
      return { x: rect.left + view.x + p.x * view.zoom, y: rect.top + view.y + p.y * view.zoom };
    };
  }, [view]);

  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = svgRef.current!.getBoundingClientRect();
      return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
    },
    [view],
  );

  // Circuit as displayed (with a live move preview while dragging).
  const display: Circuit = useMemo(() => {
    if (mode.kind !== 'drag' || (mode.delta.x === 0 && mode.delta.y === 0)) return circuit;
    try {
      return applyEdit(circuit, {
        type: 'moveItems',
        components: selection.components.map((id) => {
          const c = circuit.components.find((x) => x.id === id)!;
          return { id, x: c.x + mode.delta.x, y: c.y + mode.delta.y };
        }),
        junctions: selection.junctions.map((id) => {
          const j = circuit.junctions.find((x) => x.id === id)!;
          return { id, x: j.x + mode.delta.x, y: j.y + mode.delta.y };
        }),
      }).circuit;
    } catch {
      return circuit;
    }
  }, [circuit, mode, selection]);

  const polylines = useMemo(() => routeAll(display), [display]);

  const hitTest = useCallback(
    (p: Point): Hit => {
      const tol = 5 / Math.min(view.zoom, 1.5);
      for (const c of [...display.components].reverse()) {
        for (const pin of footprint(c).pins) {
          const pos = pinPosition(c, pin);
          if (Math.abs(pos.x - p.x) <= tol && Math.abs(pos.y - p.y) <= tol) return { kind: 'pin', id: `${c.id}.${pin.name}`, point: pos };
        }
      }
      for (const j of display.junctions) {
        if (Math.hypot(j.x - p.x, j.y - p.y) <= tol) return { kind: 'junction', id: j.id, point: { x: j.x, y: j.y } };
      }
      for (const c of [...display.components].reverse()) {
        const b = componentBounds(c);
        if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return { kind: 'component', id: c.id };
      }
      let best: { id: string; d: number; pts: Point[] } | null = null;
      for (const [id, pts] of polylines) {
        for (let i = 0; i < pts.length - 1; i++) {
          const d = distToSegment(p, pts[i]!, pts[i + 1]!);
          if (d <= tol && (!best || d < best.d)) best = { id, d, pts };
        }
      }
      if (best) {
        const proj = projectOnPolyline(best.pts, p)!;
        return { kind: 'wire', id: best.id, point: { x: snap(proj.point.x, 5), y: snap(proj.point.y, 5) } };
      }
      return { kind: 'none' };
    },
    [display, polylines, view.zoom],
  );

  const finishWire = (from: EndpointSpec, target: Hit): boolean => {
    let to: EndpointSpec | null = null;
    if (target.kind === 'pin' || target.kind === 'junction') to = target.id;
    else if (target.kind === 'wire') to = { wireId: target.id, x: target.point.x, y: target.point.y };
    if (to === null) return false;
    if (typeof from === 'string' && from === to) return false;
    attempt(() => session.edit({ type: 'connect', a: from, b: to }));
    return true;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    svgRef.current!.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      setMode({ kind: 'pan', startScreen: { x: e.clientX, y: e.clientY }, startView: view });
      return;
    }
    if (e.button !== 0) return;
    if (placing) {
      const f = footprint(placing);
      attempt(() => {
        const r = session.edit({ type: 'addComponent', componentType: placing, x: p.x - f.width / 2, y: p.y - f.height / 2 });
        const comp = r.component as Component;
        onSelect({ ...EMPTY_SELECTION, components: [comp.id] });
      });
      if (!e.shiftKey) onPlaced();
      return;
    }
    const hit = hitTest(p);
    if (mode.kind === 'wire' && mode.sticky) {
      if (hit.kind === 'none') setMode({ kind: 'idle' });
      else {
        finishWire(mode.from, hit);
        setMode({ kind: 'idle' });
      }
      return;
    }
    switch (hit.kind) {
      case 'pin':
        setMode({ kind: 'wire', from: hit.id, fromPoint: hit.point, sticky: false, moved: false, downAt: p });
        return;
      case 'junction': {
        if (!selection.junctions.includes(hit.id) && !e.shiftKey) onSelect({ ...EMPTY_SELECTION, junctions: [hit.id] });
        else if (e.shiftKey) onSelect({ ...selection, junctions: toggle(selection.junctions, hit.id) });
        if (e.ctrlKey) setMode({ kind: 'wire', from: hit.id, fromPoint: hit.point, sticky: false, moved: false, downAt: p });
        else setMode({ kind: 'drag', start: p, moved: false, delta: { x: 0, y: 0 } });
        return;
      }
      case 'wire':
        if (e.shiftKey) onSelect({ ...selection, wires: toggle(selection.wires, hit.id) });
        else onSelect({ ...EMPTY_SELECTION, wires: [hit.id] });
        setMode({ kind: 'wirePending', wireId: hit.id, at: hit.point, downAt: p });
        return;
      case 'component': {
        let sel = selection;
        if (e.shiftKey) sel = { ...selection, components: toggle(selection.components, hit.id) };
        else if (!selection.components.includes(hit.id)) sel = { ...EMPTY_SELECTION, components: [hit.id] };
        onSelect(sel);
        setMode({ kind: 'drag', start: p, moved: false, delta: { x: 0, y: 0 } });
        return;
      }
      case 'none':
        if (!e.shiftKey) onSelect(EMPTY_SELECTION);
        setMode({ kind: 'rubber', start: p, current: p });
        return;
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    setCursor(p);
    switch (mode.kind) {
      case 'pan':
        onView({ ...mode.startView, x: mode.startView.x + e.clientX - mode.startScreen.x, y: mode.startView.y + e.clientY - mode.startScreen.y });
        return;
      case 'drag': {
        const delta = { x: snap(p.x - mode.start.x), y: snap(p.y - mode.start.y) };
        if (delta.x !== mode.delta.x || delta.y !== mode.delta.y) setMode({ ...mode, delta, moved: true });
        return;
      }
      case 'rubber':
        setMode({ ...mode, current: p });
        return;
      case 'wirePending':
        if (Math.hypot(p.x - mode.downAt.x, p.y - mode.downAt.y) > 6 / view.zoom) {
          setMode({ kind: 'wire', from: { wireId: mode.wireId, x: mode.at.x, y: mode.at.y }, fromPoint: mode.at, sticky: false, moved: true, downAt: mode.downAt });
        }
        return;
      case 'wire':
        if (!mode.moved && Math.hypot(p.x - mode.downAt.x, p.y - mode.downAt.y) > 4 / view.zoom) setMode({ ...mode, moved: true });
        setHover(hitTest(p));
        return;
      default:
        setHover(hitTest(p));
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    switch (mode.kind) {
      case 'drag':
        if (mode.moved && (mode.delta.x !== 0 || mode.delta.y !== 0)) {
          attempt(() =>
            session.edit({
              type: 'moveItems',
              components: selection.components.map((id) => {
                const c = circuit.components.find((x) => x.id === id)!;
                return { id, x: c.x + mode.delta.x, y: c.y + mode.delta.y };
              }),
              junctions: selection.junctions.map((id) => {
                const j = circuit.junctions.find((x) => x.id === id)!;
                return { id, x: j.x + mode.delta.x, y: j.y + mode.delta.y };
              }),
            }),
          );
        }
        setMode({ kind: 'idle' });
        return;
      case 'rubber': {
        const x1 = Math.min(mode.start.x, mode.current.x);
        const x2 = Math.max(mode.start.x, mode.current.x);
        const y1 = Math.min(mode.start.y, mode.current.y);
        const y2 = Math.max(mode.start.y, mode.current.y);
        if (x2 - x1 > 2 || y2 - y1 > 2) {
          const comps = circuit.components
            .filter((c) => {
              const b = componentBounds(c);
              return b.x >= x1 && b.y >= y1 && b.x + b.width <= x2 && b.y + b.height <= y2;
            })
            .map((c) => c.id);
          const juncs = circuit.junctions.filter((j) => j.x >= x1 && j.x <= x2 && j.y >= y1 && j.y <= y2).map((j) => j.id);
          const inside = new Set([...comps, ...juncs]);
          const owner = (ep: string) => (ep.includes('.') ? ep.split('.')[0]! : ep);
          const wires = circuit.wires.filter((w) => inside.has(owner(w.a)) && inside.has(owner(w.b))).map((w) => w.id);
          const add = e.shiftKey ? selection : EMPTY_SELECTION;
          onSelect({
            components: [...new Set([...add.components, ...comps])],
            junctions: [...new Set([...add.junctions, ...juncs])],
            wires: [...new Set([...add.wires, ...wires])],
          });
        }
        setMode({ kind: 'idle' });
        return;
      }
      case 'wire': {
        if (!mode.moved && !mode.sticky) {
          // Click on a pin without dragging: continue in click-to-target mode.
          setMode({ ...mode, sticky: true });
          return;
        }
        if (mode.sticky) return;
        finishWire(mode.from, hitTest(p));
        setMode({ kind: 'idle' });
        return;
      }
      case 'wirePending':
      case 'pan':
        setMode({ kind: 'idle' });
        return;
      default:
        return;
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const hit = hitTest(toWorld(e.clientX, e.clientY));
    if (hit.kind !== 'component') return;
    const comp = circuit.components.find((c) => c.id === hit.id);
    if (!comp) return;
    if (comp.type === 'INPUT') attempt(() => session.toggleInput(comp.id));
    else if (comp.type === 'WORD_GENERATOR' || comp.type === 'LOGIC_ANALYZER') onOpenInstrument(comp.type);
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const zoom = Math.min(6, Math.max(0.25, view.zoom * factor));
    const wx = (sx - view.x) / view.zoom;
    const wy = (sy - view.y) / view.zoom;
    onView({ zoom, x: sx - wx * zoom, y: sy - wy * zoom });
  };

  const onDrop = (e: React.DragEvent<SVGSVGElement>) => {
    const type = e.dataTransfer.getData('application/x-openbench-component') as ComponentType;
    if (!type) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    const f = footprint(type);
    attempt(() => {
      const r = session.edit({ type: 'addComponent', componentType: type, x: p.x - f.width / 2, y: p.y - f.height / 2 });
      onSelect({ ...EMPTY_SELECTION, components: [(r.component as Component).id] });
    });
  };

  // ---------- rendering ----------
  const selComps = new Set(selection.components);
  const selWires = new Set(selection.wires);
  const selJunctions = new Set(selection.junctions);
  const junctionDegree = new Map<string, number>();
  for (const w of display.wires) {
    for (const ep of [w.a, w.b]) if (!ep.includes('.')) junctionDegree.set(ep, (junctionDegree.get(ep) ?? 0) + 1);
  }
  const netValueOfWire = (id: string): Signal | undefined => {
    const net = result.netlist.netOfWire.get(id);
    return net ? result.nets.get(net.id) : undefined;
  };

  const wireEls = display.wires.map((w) => {
    const pts = polylines.get(w.id);
    if (!pts) return null;
    const v = netValueOfWire(w.id);
    const stroke = selWires.has(w.id) ? SELECTED : showValues && v !== undefined ? VALUE_COLORS[String(v)]! : INK;
    return (
      <polyline
        key={w.id}
        data-wire={w.id}
        points={pts.map((q) => `${q.x},${q.y}`).join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={selWires.has(w.id) ? 1.6 : 1}
        strokeDasharray={showValues && v === 'X' ? '3 2' : undefined}
      />
    );
  });

  const junctionKeys = new Set(display.junctions.map((j) => `${j.x},${j.y}`));
  const branchEls = branchDots(display)
    .filter((p) => !junctionKeys.has(`${p.x},${p.y}`))
    .map((p) => <circle key={`b${p.x},${p.y}`} cx={p.x} cy={p.y} r={3} fill={INK} />);
  const junctionEls = display.junctions.map((j) => {
    const deg = junctionDegree.get(j.id) ?? 0;
    const sel = selJunctions.has(j.id);
    if (deg < 3 && !sel) return null;
    return <circle key={j.id} cx={j.x} cy={j.y} r={3} fill={sel ? SELECTED : INK} />;
  });

  const valueLabels: ReactElement[] = [];
  if (showValues) {
    for (const net of result.netlist.nets) {
      const anchor = net.drivers[0] ?? net.pins[0];
      if (!anchor) continue;
      const g = endpointGeometry(display, anchor);
      if (!g) continue;
      const v = result.nets.get(net.id);
      const dx = g.side === 'left' ? -10 : 3;
      const dy = g.side === 'bottom' ? 10 : -3;
      valueLabels.push(
        <text key={net.id} x={g.point.x + dx} y={g.point.y + dy} fontSize={8} fill={VALUE_COLORS[String(v)]} fontFamily="Arial, sans-serif" style={{ pointerEvents: 'none', userSelect: 'none' }}>
          {String(v)}
        </text>,
      );
    }
  }

  const componentEls = display.components.map((c) => {
    const pins: Record<string, Signal> = {};
    for (const p of footprint(c).pins) pins[p.name] = result.pins.get(`${c.id}.${p.name}`) ?? 'X';
    return (
      <g key={c.id} transform={`translate(${c.x},${c.y})`} data-component={c.id} data-type={c.type}>
        <title>{componentTitle(c, pins)}</title>
        <ComponentSymbol
          component={c}
          selected={selComps.has(c.id)}
          pins={pins}
          wg={c.type === 'WORD_GENERATOR' ? { address: status.currentAddress, word: status.word } : undefined}
        />
        <ComponentLabel component={c} />
      </g>
    );
  });

  let preview: ReactElement | null = null;
  if (mode.kind === 'wire' && cursor) {
    const target = hover.kind === 'pin' || hover.kind === 'junction' || hover.kind === 'wire' ? hover.point : cursor;
    const fromGeom = typeof mode.from === 'string' ? endpointGeometry(display, mode.from) : { point: mode.fromPoint };
    if (fromGeom) {
      const pts = previewRoute(display, fromGeom, { point: target });
      preview = <polyline points={pts.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={SELECTED} strokeDasharray="4 2" strokeWidth={1} />;
    }
  }
  let ghost: ReactElement | null = null;
  if (placing && cursor) {
    const f = footprint(placing);
    const ghostComp: Component = { id: 'ghost', type: placing, x: snap(cursor.x - f.width / 2), y: snap(cursor.y - f.height / 2), value: 0 };
    ghost = (
      <g transform={`translate(${ghostComp.x},${ghostComp.y})`} opacity={0.45} style={{ pointerEvents: 'none' }}>
        <ComponentSymbol component={ghostComp} selected={false} pins={{}} />
      </g>
    );
  }
  let hoverMark: ReactElement | null = null;
  if (hover.kind === 'pin' || (mode.kind === 'wire' && (hover.kind === 'junction' || hover.kind === 'wire'))) {
    const pt = hover.point;
    hoverMark = <rect x={pt.x - 3} y={pt.y - 3} width={6} height={6} fill="none" stroke={SELECTED} strokeWidth={1} style={{ pointerEvents: 'none' }} />;
  }
  let rubber: ReactElement | null = null;
  if (mode.kind === 'rubber') {
    const x = Math.min(mode.start.x, mode.current.x);
    const y = Math.min(mode.start.y, mode.current.y);
    rubber = (
      <rect
        x={x}
        y={y}
        width={Math.abs(mode.current.x - mode.start.x)}
        height={Math.abs(mode.current.y - mode.start.y)}
        fill="rgba(0,0,128,0.05)"
        stroke="#000080"
        strokeDasharray="3 2"
        strokeWidth={1 / view.zoom}
      />
    );
  }

  const cursorStyle =
    mode.kind === 'pan' ? 'grabbing' : placing ? 'copy' : mode.kind === 'wire' || hover.kind === 'pin' ? 'crosshair' : mode.kind === 'drag' && mode.moved ? 'move' : 'default';

  return (
    <svg
      ref={svgRef}
      className="schematic"
      data-testid="schematic"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-openbench-component')) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <defs>
        <pattern id="grid" width={10 * view.zoom} height={10 * view.zoom} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
          <circle cx={0.5} cy={0.5} r={0.6} fill="#9a9a9a" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="#fff" />
      {showGrid && <rect width="100%" height="100%" fill="url(#grid)" />}
      <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>
        {wireEls}
        {junctionEls}
        {branchEls}
        {componentEls}
        {valueLabels}
        {ghost}
        {preview}
        {hoverMark}
        {rubber}
      </g>
    </svg>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function componentTitle(c: Component, pins: Record<string, Signal>): string {
  const vals = Object.entries(pins)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const hint =
    c.type === 'INPUT'
      ? `\nПереключатель: верхний контакт = 1, нижний = 0. Двойной щелчок${c.key ? ` или клавиша [${c.key}]` : ''} переключает.`
      : c.type === 'WORD_GENERATOR' || c.type === 'LOGIC_ANALYZER'
        ? '\nДвойной щелчок открывает окно прибора.'
        : '';
  return `${c.label ? c.label + ' — ' : ''}${c.id} (${c.type})\n${c.type === 'WORD_GENERATOR' || c.type === 'LOGIC_ANALYZER' ? '' : vals}${hint}`;
}
