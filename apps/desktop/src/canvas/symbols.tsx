import type { Component, Signal } from '@openbench/core';
import { footprint, hex4, wordGeneratorPinX } from '@openbench/core';
import type { ReactElement } from 'react';

/** Colours of the schematic (classic engineering-editor look: black on white, selection in red). */
export const INK = '#000000';
export const SELECTED = '#e00000';
export const LABEL = '#6c6cff';
export const PROBE_ON = '#ff7c7c';

export interface SymbolProps {
  component: Component;
  selected: boolean;
  /** Pin values by pin name. */
  pins: Record<string, Signal>;
  /** Word Generator display: current address and word. */
  wg?: { address: number | null; word: number | null };
}

/** Tallest gate body; gates with more inputs get an input bar extending the back edge (ANSI style). */
const MAX_BODY = 40;

function gateBody(component: Component, ink: string): ReactElement {
  const type = component.type;
  const s = { fill: '#fff', stroke: ink, strokeWidth: 1 };
  const line = { stroke: ink, strokeWidth: 1 };
  const f = footprint(component);
  const h = f.height;
  const mid = h / 2;
  const bh = Math.min(h, MAX_BODY);
  const top = (h - bh) / 2;
  const inputs = f.pins.filter((p) => p.direction === 'input');
  // The body is drawn at the 20-unit reference height and stretched vertically.
  const body = (d: string, extra: ReactElement | null = null) => (
    <g transform={`translate(0 ${top}) scale(1 ${bh / 20})`}>
      {extra}
      <path d={d} {...s} vectorEffect="non-scaling-stroke" />
    </g>
  );
  /** Input leads ending at the back edge: x0 at the bar, curved by `bulge` inside the body. */
  const leads = (x0: number, bulge: number) => (
    <>
      {inputs.map((p) => {
        const t = (p.y - top) / bh;
        const x2 = t > 0 && t < 1 ? x0 + 4 * bulge * t * (1 - t) : x0;
        return <line key={p.name} x1={0} y1={p.y} x2={x2} y2={p.y} {...line} />;
      })}
      {top > 0 && (
        <>
          <line x1={x0} y1={5} x2={x0} y2={top} {...line} />
          <line x1={x0} y1={top + bh} x2={x0} y2={h - 5} {...line} />
        </>
      )}
    </>
  );
  const bubble = (cx: number) => <circle cx={cx} cy={mid} r={2.5} {...s} />;
  const output = (inv: boolean, x: number) => (
    <>
      {inv && bubble(x + 2.5)}
      <line x1={inv ? x + 5 : x} y1={mid} x2={40} y2={mid} {...line} />
    </>
  );
  switch (type) {
    case 'AND':
    case 'NAND':
      return (
        <>
          {leads(10, 0)}
          {body('M10,0 H21 A10,10 0 0 1 21,20 H10 Z')}
          {output(type === 'NAND', 31)}
        </>
      );
    case 'OR':
    case 'NOR':
    case 'XOR':
    case 'XNOR': {
      const ex = type === 'XOR' || type === 'XNOR';
      // Quadratic back curve from (x0,0) via (x0+6,10) to (x0,20) bulges by 3 at mid-height.
      return (
        <>
          {leads(ex ? 5.5 : 9, 3)}
          {body(
            'M9,0 Q24,0 31,10 Q24,20 9,20 Q15,10 9,0 Z',
            ex ? <path d="M5.5,0 Q11.5,10 5.5,20" fill="none" stroke={ink} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null,
          )}
          {output(type === 'NOR' || type === 'XNOR', 31)}
        </>
      );
    }
    case 'NOT':
    case 'BUFFER': {
      const inv = type === 'NOT';
      return (
        <>
          <line x1={0} y1={10} x2={10} y2={10} {...line} />
          <path d="M10,0 L30,10 L10,20 Z" {...s} />
          {inv && bubble(32.5)}
          <line x1={inv ? 35 : 30} y1={10} x2={40} y2={10} {...line} />
        </>
      );
    }
    default:
      return <></>;
  }
}

function SwitchSymbol({ component, ink }: { component: Component; ink: string }): ReactElement {
  const on = component.value === 1;
  return (
    <>
      {/* two fixed contacts (upper = logic 1, lower = logic 0) and the lever pivot */}
      <line x1={2} y1={4} x2={11} y2={4} stroke={ink} />
      <circle cx={12.5} cy={4} r={1.2} fill={ink} />
      <line x1={2} y1={16} x2={11} y2={16} stroke={ink} />
      <circle cx={12.5} cy={16} r={1.2} fill={ink} />
      <circle cx={30} cy={10} r={1.2} fill={ink} />
      <line x1={30} y1={10} x2={40} y2={10} stroke={ink} />
      <line x1={30} y1={10} x2={13.5} y2={on ? 4.8 : 15.2} stroke={ink} />
    </>
  );
}

function ProbeSymbol({ value, ink }: { value: Signal; ink: string }): ReactElement {
  const fill = value === 1 ? PROBE_ON : value === 0 ? '#fff' : value === 'E' ? '#ffd23c' : '#d8d8d8';
  return (
    <>
      <line x1={0} y1={10} x2={6} y2={10} stroke={ink} />
      <circle cx={12.5} cy={10} r={6.5} fill={fill} stroke={value === 1 ? '#2e7d7d' : ink} strokeWidth={value === 1 ? 1.4 : 1} />
      {(value === 'X' || value === 'E') && (
        <text x={12.5} y={13} fontSize={8} textAnchor="middle" fill="#000" style={{ userSelect: 'none' }}>
          {value === 'X' ? '?' : '!'}
        </text>
      )}
    </>
  );
}

function VccSymbol({ ink }: { ink: string }): ReactElement {
  return (
    <>
      <text x={0} y={9} fontSize={10} fontFamily="Arial, sans-serif" fill={ink} style={{ userSelect: 'none' }}>
        +Vcc
      </text>
      <line x1={0} y1={12} x2={23} y2={12} stroke={ink} />
      <line x1={10} y1={12} x2={10} y2={30} stroke={ink} />
    </>
  );
}

function GroundSymbol({ ink }: { ink: string }): ReactElement {
  return (
    <>
      <line x1={10} y1={0} x2={10} y2={18} stroke={ink} />
      <line x1={0} y1={18} x2={20} y2={18} stroke={ink} />
      <line x1={3.5} y1={22} x2={16.5} y2={22} stroke={ink} />
      <line x1={7} y1={26} x2={13} y2={26} stroke={ink} />
    </>
  );
}

/** Word Generator symbol: bevelled grey case, address/word display, 16 outputs along the bottom. */
function WordGeneratorSymbol({ selected, wg }: { selected: boolean; wg: SymbolProps['wg'] }): ReactElement {
  const body = selected ? SELECTED : '#c0c0c0';
  const f = footprint('WORD_GENERATOR');
  return (
    <>
      <rect x={0.5} y={0.5} width={f.width - 1} height={f.height - 4} fill={body} stroke={INK} />
      <line x1={1.5} y1={1.5} x2={f.width - 2} y2={1.5} stroke="#fff" />
      <line x1={1.5} y1={1.5} x2={1.5} y2={f.height - 5} stroke="#fff" />
      <rect x={6.5} y={4.5} width={f.width - 22} height={11} fill="#fff" stroke="#404040" />
      <text x={20} y={13.5} fontSize={9.5} fontFamily="Arial, sans-serif" fill="#1a1a50" style={{ userSelect: 'none' }}>
        {wg?.address === null || wg?.address === undefined ? '0000' : hex4(wg.address)}
      </text>
      <text x={98} y={13.5} fontSize={9.5} fontFamily="Arial, sans-serif" fill="#1a1a50" style={{ userSelect: 'none' }}>
        {wg?.word === null || wg?.word === undefined ? 'XXXX' : hex4(wg.word)}
      </text>
      {/* side terminals of the case (decorative frame of the display) */}
      <circle cx={f.width - 9} cy={7} r={1.6} fill="#fff" stroke={INK} strokeWidth={0.8} />
      <circle cx={f.width - 9} cy={13} r={1.6} fill="#fff" stroke={INK} strokeWidth={0.8} />
      {Array.from({ length: 16 }, (_, bit) => {
        const x = wordGeneratorPinX(bit);
        return (
          <g key={bit}>
            <circle cx={x} cy={22} r={1.8} fill="#fff" stroke={INK} strokeWidth={0.8} />
            <line x1={x} y1={23.8} x2={x} y2={30} stroke={INK} />
          </g>
        );
      })}
    </>
  );
}

/** Logic Analyzer symbol: vertical case with 16 inputs on the left and a waveform panel. */
function LogicAnalyzerSymbol({ selected }: { selected: boolean }): ReactElement {
  const body = selected ? SELECTED : '#c0c0c0';
  const f = footprint('LOGIC_ANALYZER');
  const waves: ReactElement[] = [];
  for (let i = 0; i < 16; i++) {
    const y = 10 + i * 10;
    const k = (i * 7) % 5;
    const d =
      k === 0
        ? `M18,${y + 2} h4 v-4 h6 v4 h4`
        : k === 1
          ? `M18,${y - 2} h6 v4 h3 v-4 h5`
          : k === 2
            ? `M18,${y + 2} h3 v-4 h3 v4 h3 v-4 h5`
            : k === 3
              ? `M18,${y - 2} h9 v4 h5`
              : `M18,${y + 2} h5 v-4 h4 v4 h5`;
    waves.push(<path key={i} d={d} fill="none" stroke={INK} strokeWidth={0.8} />);
  }
  return (
    <>
      <rect x={6.5} y={0.5} width={f.width - 7} height={f.height - 1} fill={body} stroke={INK} />
      <line x1={7.5} y1={1.5} x2={f.width - 1.5} y2={1.5} stroke="#fff" />
      <line x1={7.5} y1={1.5} x2={7.5} y2={f.height - 1.5} stroke="#fff" />
      <rect x={15.5} y={4.5} width={20} height={163} fill="#fff" stroke="#404040" />
      {waves}
      {Array.from({ length: 16 }, (_, ch) => (
        <g key={ch}>
          <line x1={0} y1={10 + ch * 10} x2={8.2} y2={10 + ch * 10} stroke={INK} />
          <circle cx={10} cy={10 + ch * 10} r={1.8} fill="#fff" stroke={INK} strokeWidth={0.8} />
        </g>
      ))}
      {[14, 24, 34].map((x) => (
        <circle key={x} cx={x - 2} cy={174} r={1.6} fill="#fff" stroke={INK} strokeWidth={0.8} />
      ))}
    </>
  );
}

export function ComponentSymbol({ component, selected, pins, wg }: SymbolProps): ReactElement {
  const ink = selected ? SELECTED : INK;
  switch (component.type) {
    case 'INPUT':
      return <SwitchSymbol component={component} ink={ink} />;
    case 'OUTPUT':
      return <ProbeSymbol value={pins.IN ?? 'X'} ink={ink} />;
    case 'CONST1':
      return <VccSymbol ink={ink} />;
    case 'CONST0':
      return <GroundSymbol ink={ink} />;
    case 'WORD_GENERATOR':
      return <WordGeneratorSymbol selected={selected} wg={wg} />;
    case 'LOGIC_ANALYZER':
      return <LogicAnalyzerSymbol selected={selected} />;
    default:
      return gateBody(component, ink);
  }
}

/** Blue labels above the component, as on classic lab schematics: name and `[key]` for switches. */
export function ComponentLabel({ component }: { component: Component }): ReactElement | null {
  const lines: string[] = [];
  if (component.label) lines.push(component.label);
  if (component.type === 'INPUT' && component.key) lines.push(`[${component.key}]`);
  if (lines.length === 0) return null;
  const w = footprint(component).width;
  return (
    <text
      x={component.type === 'INPUT' ? w / 2 - 2 : w / 2}
      y={-4 - (lines.length - 1) * 11}
      fontSize={10}
      fontFamily="Arial, sans-serif"
      fill={LABEL}
      textAnchor="middle"
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={component.type === 'INPUT' ? w / 2 - 2 : w / 2} dy={i === 0 ? 0 : 11}>
          {l}
        </tspan>
      ))}
    </text>
  );
}
