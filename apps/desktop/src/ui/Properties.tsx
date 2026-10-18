import type { Diagnostic } from '@openbench/core';
import { MAX_GATE_INPUTS, MIN_GATE_INPUTS, componentPins, gateInputCount, isMultiInputGateType } from '@openbench/core';
import type { ReactElement } from 'react';
import type { Selection } from '../canvas/Schematic';
import { attempt, session, useSessionVersion } from '../store';

const TYPE_NAMES: Record<string, string> = {
  INPUT: 'Переключатель (INPUT)',
  OUTPUT: 'Пробник (OUTPUT)',
  CONST0: 'Логический 0 (земля)',
  CONST1: 'Логическая 1 (+Vcc)',
  WORD_GENERATOR: 'Word Generator',
  LOGIC_ANALYZER: 'Logic Analyzer',
};

export function Properties({ selection, onSelectComponent }: { selection: Selection; onSelectComponent: (id: string) => void }): ReactElement {
  useSessionVersion();
  const circuit = session.circuit;
  const result = session.result;
  const diagnostics = session.diagnostics;
  const comp = selection.components.length === 1 ? circuit.components.find((c) => c.id === selection.components[0]) : undefined;
  const wire = !comp && selection.wires.length === 1 ? circuit.wires.find((w) => w.id === selection.wires[0]) : undefined;
  const total = selection.components.length + selection.wires.length + selection.junctions.length;

  let body: ReactElement;
  if (comp) {
    const pins = componentPins(comp);
    body = (
      <div className="props" data-testid="properties">
        <div className="props-row">
          <span>ID</span>
          <b>{comp.id}</b>
        </div>
        <div className="props-row">
          <span>Тип</span>
          <span>{TYPE_NAMES[comp.type] ?? comp.type}</span>
        </div>
        <label className="props-row">
          <span>Подпись</span>
          <input
            key={comp.id + (comp.label ?? '')}
            defaultValue={comp.label ?? ''}
            maxLength={64}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => e.target.value !== (comp.label ?? '') && attempt(() => session.edit({ type: 'setComponentProps', id: comp.id, label: e.target.value }))}
          />
        </label>
        {isMultiInputGateType(comp.type) && (
          <label className="props-row">
            <span>Входов</span>
            <select
              data-testid="gate-inputs"
              value={gateInputCount(comp)}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => attempt(() => session.edit({ type: 'setComponentProps', id: comp.id, inputs: Number(e.target.value) }))}
            >
              {Array.from({ length: MAX_GATE_INPUTS - MIN_GATE_INPUTS + 1 }, (_, i) => MIN_GATE_INPUTS + i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {comp.type === 'INPUT' && (
          <>
            <label className="props-row">
              <span>Клавиша</span>
              <input
                key={comp.id + (comp.key ?? '')}
                defaultValue={comp.key ?? ''}
                maxLength={1}
                size={2}
                onKeyDown={(e) => e.stopPropagation()}
                onBlur={(e) => e.target.value !== (comp.key ?? '') && attempt(() => session.edit({ type: 'setComponentProps', id: comp.id, key: e.target.value }))}
              />
            </label>
            <div className="props-row">
              <span>Значение</span>
              <button data-testid="toggle-input" onClick={() => attempt(() => session.toggleInput(comp.id))}>
                {comp.value === 1 ? '1 — переключить в 0' : '0 — переключить в 1'}
              </button>
            </div>
          </>
        )}
        <div className="props-sub">Выводы</div>
        <table className="props-pins">
          <tbody>
            {pins.map((p) => {
              const net = result.netlist.netOfPin.get(p.id);
              const v = result.pins.get(p.id);
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.direction === 'input' ? 'вход' : 'выход'}</td>
                  <td className={`sig sig-${String(v)}`}>{net || p.direction === 'output' ? String(v) : '—'}</td>
                  <td className="muted">{net ? net.id : 'не подключён'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  } else if (wire) {
    const net = result.netlist.netOfWire.get(wire.id);
    body = (
      <div className="props" data-testid="properties">
        <div className="props-row">
          <span>Провод</span>
          <b>{wire.id}</b>
        </div>
        <div className="props-row">
          <span>Концы</span>
          <span>
            {wire.a} — {wire.b}
          </span>
        </div>
        {net && (
          <>
            <div className="props-row">
              <span>Сеть</span>
              <span>{net.id}</span>
            </div>
            <div className="props-row">
              <span>Значение</span>
              <span className={`sig sig-${String(result.nets.get(net.id))}`}>{String(result.nets.get(net.id))}</span>
            </div>
            <div className="props-row">
              <span>Драйвер</span>
              <span>{net.drivers.length === 0 ? 'нет' : net.drivers.join(', ')}</span>
            </div>
            <div className="props-row">
              <span>Входы</span>
              <span>{net.sinks.join(', ') || '—'}</span>
            </div>
          </>
        )}
        {wire.points && (
          <button onClick={() => attempt(() => session.edit({ type: 'setWirePoints', wireId: wire.id, points: null }))}>Перетрассировать автоматически</button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="props muted" data-testid="properties">
        {total > 1 ? `Выделено объектов: ${total}` : 'Ничего не выделено.'}
        <div className="props-help">
          <p>Провод: потяните от вывода к выводу или проводу (или щёлкните вывод, затем цель).</p>
          <p>Ответвление: потяните от существующего провода.</p>
          <p>Delete — удалить, Esc — отмена, колесо — масштаб, средняя/правая кнопка — панорама.</p>
        </div>
      </div>
    );
  }

  return (
    <aside className="properties">
      <div className="panel-title">Свойства</div>
      {body}
      <div className="panel-title">Диагностика</div>
      <Diagnostics items={diagnostics} onSelectComponent={onSelectComponent} />
    </aside>
  );
}

function Diagnostics({ items, onSelectComponent }: { items: Diagnostic[]; onSelectComponent: (id: string) => void }): ReactElement {
  if (items.length === 0) return <div className="diag muted">Ошибок нет</div>;
  return (
    <ul className="diag" data-testid="diagnostics">
      {items.map((d, i) => (
        <li key={i} className={`diag-${d.severity}`}>
          <span className="diag-mark">{d.severity === 'error' ? '✖' : '⚠'}</span>
          <span
            className={d.componentIds?.length ? 'link' : undefined}
            onClick={() => d.componentIds?.[0] && onSelectComponent(d.componentIds[0])}
          >
            {d.message}
          </span>
        </li>
      ))}
    </ul>
  );
}
