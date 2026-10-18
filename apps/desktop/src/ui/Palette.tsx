import type { ComponentType } from '@openbench/core';
import { footprint } from '@openbench/core';
import type { ReactElement } from 'react';
import { ComponentSymbol } from '../canvas/symbols';

const GROUPS: { title: string; items: { type: ComponentType; name: string }[] }[] = [
  {
    title: 'Источники',
    items: [
      { type: 'INPUT', name: 'Переключатель' },
      { type: 'CONST1', name: '+Vcc (1)' },
      { type: 'CONST0', name: 'Земля (0)' },
    ],
  },
  {
    title: 'Логика',
    items: [
      { type: 'BUFFER', name: 'Буфер' },
      { type: 'NOT', name: 'НЕ (NOT)' },
      { type: 'AND', name: 'И (AND)' },
      { type: 'NAND', name: 'И-НЕ (NAND)' },
      { type: 'OR', name: 'ИЛИ (OR)' },
      { type: 'NOR', name: 'ИЛИ-НЕ (NOR)' },
      { type: 'XOR', name: 'Искл. ИЛИ (XOR)' },
      { type: 'XNOR', name: 'Искл. ИЛИ-НЕ' },
    ],
  },
  {
    title: 'Индикаторы',
    items: [{ type: 'OUTPUT', name: 'Пробник' }],
  },
  {
    title: 'Приборы',
    items: [
      { type: 'WORD_GENERATOR', name: 'Word Generator' },
      { type: 'LOGIC_ANALYZER', name: 'Logic Analyzer' },
    ],
  },
];

function Icon({ type }: { type: ComponentType }): ReactElement {
  const f = footprint(type);
  const pad = 4;
  return (
    <svg width={44} height={22} viewBox={`${-pad} ${-pad} ${f.width + 2 * pad} ${f.height + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <ComponentSymbol component={{ id: 'icon', type, x: 0, y: 0, value: 1 }} selected={false} pins={{ IN: 0 }} />
    </svg>
  );
}

export function Palette({ placing, onPick }: { placing: ComponentType | null; onPick: (t: ComponentType | null) => void }): ReactElement {
  return (
    <aside className="palette" aria-label="Палитра элементов">
      {GROUPS.map((g) => (
        <div key={g.title} className="palette-group">
          <div className="palette-title">{g.title}</div>
          {g.items.map((it) => (
            <button
              key={it.type}
              className={`palette-item${placing === it.type ? ' pressed' : ''}`}
              data-testid={`palette-${it.type}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-openbench-component', it.type);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => onPick(placing === it.type ? null : it.type)}
              title={`${it.name}: щёлкните и затем щёлкните на схеме (Shift — несколько), или перетащите на схему`}
            >
              <Icon type={it.type} />
              <span>{it.name}</span>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
