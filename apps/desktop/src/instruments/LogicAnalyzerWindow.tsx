import type { Frame, Signal } from '@openbench/core';
import { ANALYZER_CHANNELS, analyzerChannelValues } from '@openbench/core';
import type { ReactElement } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { attempt, session, useSessionVersion } from '../store';

const ROW = 16;
const DIVISION = 32;
const PLOT_W = 330;
const PLOT_H = ROW * ANALYZER_CHANNELS + 6;

function channelHex(f: Frame | undefined): string {
  if (!f) return '----';
  let v = 0;
  for (let ch = 0; ch < ANALYZER_CHANNELS; ch++) {
    const s = f.channels[ch];
    if (s === 'X' || s === 'E') return 'XXXX';
    if (s === 1) v |= 1 << ch;
  }
  return v.toString(16).toUpperCase().padStart(4, '0');
}

export function LogicAnalyzerWindow(): ReactElement {
  useSessionVersion();
  const la = session.circuit.instruments.logicAnalyzer;
  const history = session.history;
  const status = session.status();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [t1, setT1] = useState<number | null>(null);
  const [t2, setT2] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const drag = useRef<'t1' | 't2' | null>(null);

  const pxPerTick = DIVISION / la.clocksPerDivision;
  const firstTick = history[0]?.tick ?? 0;
  const lastTick = history.length ? history[history.length - 1]!.tick : 0;
  const span = history.length ? lastTick - firstTick + 1 : 0;
  const totalW = Math.max(PLOT_W, span * pxPerTick + DIVISION);

  // Follow the newest samples while running unless the user scrolled back.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    el.scrollLeft = Math.max(0, totalW - PLOT_W);
    setScrollLeft(el.scrollLeft);
  }, [totalW, follow]);

  useEffect(() => {
    if (history.length === 0) {
      setT1(null);
      setT2(null);
    }
  }, [history.length]);

  const xOfTick = (tick: number) => (tick - firstTick) * pxPerTick - scrollLeft;
  const tickAtX = (x: number) => {
    const t = Math.floor((x + scrollLeft) / pxPerTick) + firstTick;
    return Math.max(firstTick, Math.min(lastTick, t));
  };
  const frameAt = (tick: number | null): Frame | undefined => (tick === null ? undefined : history[tick - firstTick]);

  const visibleFrom = Math.max(0, Math.floor(scrollLeft / pxPerTick) - 1);
  const visibleTo = Math.min(history.length, Math.ceil((scrollLeft + PLOT_W) / pxPerTick) + 1);
  const live = analyzerChannelValues(session.circuit, session.result);
  const t1Frame = frameAt(t1);
  const t2Frame = frameAt(t2);
  const circleValues: (Signal | null)[] = t1Frame ? t1Frame.channels : live;

  const rows: ReactElement[] = [];
  for (let ch = 0; ch < ANALYZER_CHANNELS; ch++) {
    const cfg = la.channels[ch]!;
    const mid = 4 + ch * ROW + ROW / 2;
    const lo = mid + 3;
    const hi = mid - 4;
    rows.push(<line key={`b${ch}`} x1={0} y1={lo} x2={PLOT_W} y2={lo} stroke="#000" strokeWidth={1} strokeDasharray="1 3" opacity={0.55} />);
    if (!cfg.visible) continue;
    let d = '';
    const xs: ReactElement[] = [];
    let prevY: number | null = null;
    for (let i = visibleFrom; i < visibleTo; i++) {
      const f = history[i]!;
      const s = f.channels[ch] ?? null;
      const x0 = xOfTick(f.tick);
      const x1 = x0 + pxPerTick;
      if (s === 0 || s === 1) {
        const y = s === 1 ? hi : lo;
        if (prevY === null) d += `M${x0},${y}`;
        else if (prevY !== y) d += `L${x0},${prevY}L${x0},${y}`;
        else d += `L${x0},${y}`;
        d += `L${x1},${y}`;
        prevY = y;
      } else {
        prevY = null;
        if (s === 'X' || s === 'E') {
          xs.push(
            <rect key={i} x={x0} y={hi} width={pxPerTick} height={lo - hi} fill={s === 'E' ? '#ffcf70' : '#d6d6d6'} stroke={s === 'E' ? '#d07000' : '#7a7a7a'} strokeWidth={0.8}>
              <title>{s === 'X' ? 'X — неизвестно' : 'E — конфликт драйверов'}</title>
            </rect>,
          );
        }
      }
    }
    rows.push(<g key={`x${ch}`}>{xs}</g>);
    if (d) rows.push(<path key={`w${ch}`} d={d} fill="none" stroke="#000" strokeWidth={1.2} data-channel={ch} />);
  }
  const divisions: ReactElement[] = [];
  const firstDiv = Math.floor(scrollLeft / DIVISION);
  for (let k = firstDiv; k * DIVISION < scrollLeft + PLOT_W; k++) {
    const x = k * DIVISION - scrollLeft;
    for (let ch = 0; ch < ANALYZER_CHANNELS; ch++) {
      const lo = 4 + ch * ROW + ROW / 2 + 3;
      divisions.push(<line key={`${k}-${ch}`} x1={x} y1={lo - 2} x2={x} y2={lo + 1} stroke="#000" strokeWidth={1} opacity={0.6} />);
    }
  }

  const onPlotPointer = (e: React.PointerEvent<SVGSVGElement>, phase: 'down' | 'move' | 'up') => {
    if (history.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (phase === 'down') {
      const near2 = t2 !== null && Math.abs(xOfTick(t2) + pxPerTick / 2 - x) < 6;
      drag.current = e.shiftKey || e.button === 2 || near2 ? 't2' : 't1';
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (!drag.current) return;
    const t = tickAtX(x);
    if (drag.current === 't1') setT1(t);
    else setT2(t);
    if (phase === 'up') drag.current = null;
  };

  const markerX = (t: number | null, fallback: number) => (t === null ? fallback : xOfTick(t) + pxPerTick / 2);
  const x1 = markerX(t1, 1);
  const x2 = markerX(t2, PLOT_W - 1);

  return (
    <div className="la" data-testid="logic-analyzer">
      <div className="la-main">
        <div className="la-circles">
          <div className="la-ruler-pad" />
          {Array.from({ length: ANALYZER_CHANNELS }, (_, ch) => {
            const v = circleValues[ch];
            const cfg = la.channels[ch]!;
            return (
              <button
                key={ch}
                className={`la-circle${cfg.visible ? '' : ' la-circle-hidden'}`}
                data-testid={`la-ch${ch}`}
                title={`${cfg.label}: ${v === null || v === undefined ? 'не подключён (—)' : v}${cfg.visible ? '' : ' (скрыт)'}\nЩелчок — показать/скрыть канал`}
                onClick={() => attempt(() => session.edit({ type: 'configureAnalyzer', channels: [{ index: ch, visible: !cfg.visible }] }))}
              >
                {v === null || v === undefined ? '' : String(v)}
              </button>
            );
          })}
        </div>
        <div className="la-plot-wrap sunken">
          <svg className="la-ruler" width={PLOT_W} height={10}>
            <polygon points={`${x1 - 5},0 ${x1 + 5},0 ${x1},8`} fill="#e00000" />
            <text x={x1} y={6} fontSize={6} fill="#fff" textAnchor="middle">
              1
            </text>
            <polygon points={`${x2 - 5},0 ${x2 + 5},0 ${x2},8`} fill="#1030d0" />
            <text x={x2} y={6} fontSize={6} fill="#fff" textAnchor="middle">
              2
            </text>
          </svg>
          <svg
            className="la-plot"
            width={PLOT_W}
            height={PLOT_H}
            data-testid="la-plot"
            onPointerDown={(e) => onPlotPointer(e, 'down')}
            onPointerMove={(e) => onPlotPointer(e, 'move')}
            onPointerUp={(e) => onPlotPointer(e, 'up')}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => {
              if (!e.ctrlKey) return;
              const next = Math.max(1, Math.min(64, la.clocksPerDivision * (e.deltaY > 0 ? 2 : 0.5)));
              attempt(() => session.edit({ type: 'configureAnalyzer', clocksPerDivision: Math.round(next) }));
            }}
          >
            <rect width={PLOT_W} height={PLOT_H} fill="#fff" />
            {divisions}
            {rows}
            <line x1={x1} y1={0} x2={x1} y2={PLOT_H} stroke="#e00000" strokeWidth={1.5} />
            <line x1={x2} y1={0} x2={x2} y2={PLOT_H} stroke="#1030d0" strokeWidth={1} />
          </svg>
          <div
            className="la-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScrollLeft(el.scrollLeft);
              setFollow(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
            }}
          >
            <div style={{ width: totalW, height: 1 }} />
          </div>
        </div>
      </div>
      <div className="la-bottom">
        <div className="la-cell la-buttons">
          <button onClick={() => session.stop()} title="Остановить симуляцию">
            Stop
          </button>
          <button onClick={() => session.clearHistory()} title="Очистить историю анализатора" data-testid="la-reset">
            Reset
          </button>
        </div>
        <div className="la-cell la-times">
          <div className="la-time-labels">
            <span>T1</span>
            <span>T2</span>
            <span>T2-T1</span>
          </div>
          <div className="la-time-values sunken" data-testid="la-times">
            <span>{t1 === null ? '' : `${t1} tick`}</span>
            <span>{t2 === null ? '' : `${t2} tick`}</span>
            <span>{t1 !== null && t2 !== null ? `${t2 - t1} tick` : ''}</span>
          </div>
          <div className="la-hex sunken" title="Значения CH15…CH0 под курсорами T1 / T2 (hex)">
            <span data-testid="la-t1-hex">{t1Frame ? channelHex(t1Frame) : '0000'}</span>
            <span>{t2Frame ? channelHex(t2Frame) : '0000'}</span>
          </div>
        </div>
        <div className="la-cell la-zoom">
          <label>
            Clocks per division
            <input
              type="number"
              min={1}
              max={64}
              value={la.clocksPerDivision}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 1 && v <= 64) attempt(() => session.edit({ type: 'configureAnalyzer', clocksPerDivision: v }));
              }}
            />
          </label>
          <div className="la-info">
            {history.length} / {la.maxHistory} кадров{status.droppedFrames > 0 ? ` · усечено ${status.droppedFrames}` : ''}
          </div>
          <button onClick={() => setChannelsOpen((o) => !o)}>Каналы…</button>
        </div>
      </div>
      {channelsOpen && (
        <div className="la-channels raised">
          {la.channels.map((c, i) => (
            <label key={i}>
              <input type="checkbox" checked={c.visible} onChange={(e) => attempt(() => session.edit({ type: 'configureAnalyzer', channels: [{ index: i, visible: e.target.checked }] }))} />
              <span className="la-ch-name">CH{i}</span>
              <input
                defaultValue={c.label}
                maxLength={32}
                onKeyDown={(e) => e.stopPropagation()}
                onBlur={(e) => e.target.value !== c.label && attempt(() => session.edit({ type: 'configureAnalyzer', channels: [{ index: i, label: e.target.value }] }))}
              />
            </label>
          ))}
          <button onClick={() => setChannelsOpen(false)}>OK</button>
        </div>
      )}
    </div>
  );
}
