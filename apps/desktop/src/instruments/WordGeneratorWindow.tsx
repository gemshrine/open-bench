import { MAX_WORDS, hex4 } from '@openbench/core';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { attempt, session, useSessionVersion } from '../store';

type Pattern = 'clear' | 'up' | 'down' | 'shr' | 'shl';

function patternWords(p: Pattern, n: number): number[] {
  switch (p) {
    case 'clear':
      return Array.from({ length: n }, () => 0);
    case 'up':
      return Array.from({ length: n }, (_, i) => i & 0xffff);
    case 'down':
      return Array.from({ length: n }, (_, i) => (0xffff - i) & 0xffff);
    case 'shr':
      return Array.from({ length: n }, (_, i) => (0x8000 >>> (i % 16)) & 0xffff);
    case 'shl':
      return Array.from({ length: n }, (_, i) => (1 << (i % 16)) & 0xffff);
  }
}

function parseHex(s: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(s.trim())) return null;
  return parseInt(s.trim(), 16);
}

export function WordGeneratorWindow(): ReactElement {
  useSessionVersion();
  const wg = session.circuit.instruments.wordGenerator;
  const status = session.status();
  const words = wg.words;
  const [edit, setEdit] = useState(0);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [rowText, setRowText] = useState('');
  const [patternOpen, setPatternOpen] = useState(false);
  const [pattern, setPattern] = useState<Pattern>('up');
  const listRef = useRef<HTMLDivElement>(null);
  const editAddr = Math.min(edit, Math.max(0, words.length - 1));
  const editWord = words[editAddr];

  // Keep the current output address visible while running.
  useEffect(() => {
    if (status.currentAddress === null || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-addr="${status.currentAddress}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [status.currentAddress]);

  const setWords = (next: number[]) => attempt(() => session.edit({ type: 'setWords', words: next }));
  const setWordAt = (addr: number, value: number) => {
    const next = [...words];
    next[addr] = value & 0xffff;
    setWords(next);
  };

  const play = (cycle: boolean) => {
    if (status.running) {
      session.stop();
      if (wg.cycle === cycle) return;
    }
    attempt(() => {
      if (wg.cycle !== cycle) session.edit({ type: 'configureWordGenerator', cycle });
      session.run();
    });
  };

  const commitRow = () => {
    if (editingRow === null) return;
    const v = parseHex(rowText);
    if (v !== null) setWordAt(editingRow, v);
    setEditingRow(null);
  };

  const rows = words.map((w, i) => {
    const isCurrent = status.currentAddress === i;
    const isEdit = editAddr === i;
    return (
      <div
        key={i}
        data-addr={i}
        className={`wg-row${isEdit ? ' wg-row-edit' : ''}${isCurrent ? ' wg-row-current' : ''}`}
        onClick={() => setEdit(i)}
        onDoubleClick={() => {
          setEditingRow(i);
          setRowText(hex4(w));
        }}
        title={`Адрес ${hex4(i)}`}
      >
        {editingRow === i ? (
          <input
            className="wg-row-input"
            autoFocus
            value={rowText}
            maxLength={4}
            onChange={(e) => setRowText(e.target.value)}
            onBlur={commitRow}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRow();
              if (e.key === 'Escape') setEditingRow(null);
              e.stopPropagation();
            }}
          />
        ) : (
          hex4(w)
        )}
      </div>
    );
  });

  const bits = Array.from({ length: 16 }, (_, k) => 15 - k);
  const binary = editWord === undefined ? '' : editWord.toString(2).padStart(16, '0');
  const ascii = editWord === undefined ? '' : (editWord & 0xff).toString(16).toUpperCase().padStart(2, '0');

  return (
    <div className="wg" data-testid="word-generator">
      <div className="wg-top">
        <div className="wg-list-wrap">
          <div className="wg-list sunken" ref={listRef} tabIndex={0} onKeyDown={(e) => onListKey(e)} aria-label="Последовательность слов">
            {words.length === 0 ? <div className="wg-empty">пусто</div> : rows}
          </div>
          <div className="wg-list-tools">
            <button title="Вставить слово после выбранного (Insert)" onClick={() => insertAfter(false)} disabled={words.length >= MAX_WORDS}>
              +
            </button>
            <button title="Дублировать выбранное слово" onClick={() => insertAfter(true)} disabled={words.length >= MAX_WORDS || words.length === 0}>
              ⧉
            </button>
            <button title="Удалить выбранное слово (Delete)" onClick={removeSelected} disabled={words.length === 0}>
              −
            </button>
            <button title="Переместить вверх" onClick={() => moveSelected(-1)} disabled={editAddr === 0}>
              ↑
            </button>
            <button title="Переместить вниз" onClick={() => moveSelected(1)} disabled={editAddr >= words.length - 1}>
              ↓
            </button>
          </div>
        </div>
        <div className="wg-right">
          <div className="wg-row2">
            <fieldset className="group wg-address">
              <legend>Address</legend>
              <label>
                <span>Edit</span>
                <HexField
                  value={words.length ? hex4(editAddr) : ''}
                  onCommit={(v) => {
                    if (v < words.length) setEdit(v);
                  }}
                  testId="wg-edit"
                />
              </label>
              <label>
                <span>Current</span>
                <input readOnly value={status.currentAddress === null ? '' : hex4(status.currentAddress)} data-testid="wg-current" />
              </label>
              <label>
                <span>Initial</span>
                <input readOnly value="0000" disabled title="Последовательность всегда начинается с адреса 0000" />
              </label>
              <label>
                <span>Final</span>
                <HexField
                  value={words.length ? hex4(words.length - 1) : ''}
                  onCommit={(v) => {
                    const n = Math.min(MAX_WORDS, v + 1);
                    setWords(Array.from({ length: n }, (_, i) => words[i] ?? 0));
                  }}
                  testId="wg-final"
                  title={`Последний адрес; длина последовательности ≤ ${MAX_WORDS} слов`}
                />
              </label>
            </fieldset>
            <div className="wg-buttons">
              <button className={status.running && wg.cycle ? 'pressed' : ''} onClick={() => play(true)} title="Циклическое воспроизведение">
                Cycle
              </button>
              <button className={status.running && !wg.cycle ? 'pressed' : ''} onClick={() => play(false)} title="Воспроизвести до конца последовательности">
                Burst
              </button>
              <button onClick={() => attempt(() => session.step(1))} data-testid="wg-step" title="Один шаг (F6)">
                Step
              </button>
              <button onClick={() => session.reset()} title="Сброс к адресу 0000 и очистка истории анализатора">
                Reset
              </button>
              <button onClick={() => setPatternOpen((o) => !o)}>Pattern...</button>
            </div>
          </div>
          <fieldset className="group wg-freq">
            <legend>Frequency</legend>
            <input
              type="number"
              min={0.1}
              max={1000}
              step={1}
              value={wg.stepsPerSecond}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 0.1 && v <= 1000)
                  attempt(() => {
                    session.edit({ type: 'configureWordGenerator', stepsPerSecond: v });
                    session.restartIfRunning();
                  });
              }}
              aria-label="Шагов в секунду"
            />
            <span className="unit">шаг/с</span>
            <label className="wg-cycle-check" title="При достижении конца переходить к первому слову">
              <input type="checkbox" checked={wg.cycle} onChange={(e) => attempt(() => session.edit({ type: 'configureWordGenerator', cycle: e.target.checked }))} />
              Cycle
            </label>
          </fieldset>
          <div className="wg-codes">
            <label>
              <span>ASCII</span>
              <HexField
                value={ascii}
                width={3}
                maxLength={2}
                onCommit={(v) => editWord !== undefined && setWordAt(editAddr, (editWord & 0xff00) | (v & 0xff))}
              />
              <span className="wg-ascii-char">{editWord !== undefined && (editWord & 0xff) >= 32 && (editWord & 0xff) < 127 ? String.fromCharCode(editWord & 0xff) : ''}</span>
            </label>
            <label>
              <span>Binary</span>
              <BinaryField value={binary} onCommit={(v) => words.length > 0 && setWordAt(editAddr, v)} />
            </label>
          </div>
        </div>
      </div>
      {patternOpen && (
        <div className="wg-pattern raised">
          <div className="wg-pattern-title">Pattern</div>
          {(
            [
              ['clear', 'Очистить буфер (все 0000)'],
              ['up', 'Счётчик вверх (0000, 0001, …)'],
              ['down', 'Счётчик вниз (FFFF, FFFE, …)'],
              ['shr', 'Сдвиг вправо (8000, 4000, …)'],
              ['shl', 'Сдвиг влево (0001, 0002, …)'],
            ] as [Pattern, string][]
          ).map(([k, label]) => (
            <label key={k}>
              <input type="radio" name="wg-pattern" checked={pattern === k} onChange={() => setPattern(k)} /> {label}
            </label>
          ))}
          <div className="wg-pattern-buttons">
            <button
              onClick={() => {
                setWords(patternWords(pattern, Math.max(1, words.length)));
                setPatternOpen(false);
              }}
            >
              Accept
            </button>
            <button onClick={() => setPatternOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="wg-bits" data-testid="wg-bits" title="Текущие выходы D15…D0">
        {bits.map((b) => (
          <span key={b} className="bit-circle" title={`D${b}`}>
            {status.word === null ? '' : (status.word >> b) & 1}
          </span>
        ))}
      </div>
      {words.length === 0 && <div className="wg-hint">Последовательность пуста — добавьте слово кнопкой «+».</div>}
    </div>
  );

  function insertAfter(duplicate: boolean) {
    const at = words.length === 0 ? 0 : editAddr + 1;
    const value = duplicate ? (words[editAddr] ?? 0) : 0;
    setWords([...words.slice(0, at), value, ...words.slice(at)]);
    setEdit(at);
  }
  function removeSelected() {
    if (words.length === 0) return;
    setWords(words.filter((_, i) => i !== editAddr));
    setEdit(Math.max(0, editAddr - 1));
  }
  function moveSelected(d: number) {
    const j = editAddr + d;
    if (j < 0 || j >= words.length) return;
    const next = [...words];
    [next[editAddr], next[j]] = [next[j]!, next[editAddr]!];
    setWords(next);
    setEdit(j);
  }
  function onListKey(e: React.KeyboardEvent) {
    if (editingRow !== null) return;
    if (e.key === 'ArrowDown') setEdit(Math.min(words.length - 1, editAddr + 1));
    else if (e.key === 'ArrowUp') setEdit(Math.max(0, editAddr - 1));
    else if (e.key === 'Insert') insertAfter(false);
    else if (e.key === 'Delete') removeSelected();
    else if (e.key === 'Enter') {
      setEditingRow(editAddr);
      setRowText(hex4(words[editAddr] ?? 0));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
}

function HexField(props: { value: string; onCommit: (v: number) => void; testId?: string; title?: string; width?: number; maxLength?: number }): ReactElement {
  const [text, setText] = useState(props.value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : props.value;
  const commit = () => {
    const v = parseHex(text);
    if (v !== null) props.onCommit(v);
  };
  return (
    <input
      value={shown}
      size={props.width ?? 5}
      maxLength={props.maxLength ?? 4}
      data-testid={props.testId}
      title={props.title}
      onFocus={() => {
        setText(props.value);
        setFocused(true);
      }}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function BinaryField({ value, onCommit }: { value: string; onCommit: (v: number) => void }): ReactElement {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const commit = () => {
    if (/^[01]{1,16}$/.test(text)) onCommit(parseInt(text, 2));
  };
  return (
    <input
      className="wg-binary"
      data-testid="wg-binary"
      value={focused ? text : value}
      maxLength={16}
      size={18}
      onFocus={() => {
        setText(value);
        setFocused(true);
      }}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
      onChange={(e) => setText(e.target.value.replace(/[^01]/g, ''))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
      }}
      title="D15…D0 выбранного слова (D0 — младший бит, справа)"
    />
  );
}
