import type { ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';

interface Props {
  title: string;
  initial: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  zIndex: number;
  onFocus: () => void;
}

/** Movable instrument window with a classic title bar. Kept inside the workspace area. */
export function FloatingWindow({ title, initial, onClose, children, testId, zIndex, onFocus }: Props): ReactElement {
  const [pos, setPos] = useState(initial);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      className="float-window"
      style={{ left: pos.x, top: pos.y, zIndex }}
      data-testid={testId}
      onPointerDownCapture={onFocus}
      role="dialog"
      aria-label={title}
    >
      <div
        className="float-title"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const parent = ref.current?.parentElement?.getBoundingClientRect();
          const w = ref.current?.offsetWidth ?? 200;
          const maxX = parent ? parent.width - 60 : 4000;
          const maxY = parent ? parent.height - 24 : 4000;
          setPos({
            x: Math.max(-w + 60, Math.min(maxX, e.clientX - drag.current.dx)),
            y: Math.max(0, Math.min(maxY, e.clientY - drag.current.dy)),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <span className="float-icon" aria-hidden />
        <span className="float-caption">{title}</span>
        <button className="float-close" onClick={onClose} aria-label="Закрыть" title="Закрыть">
          ✕
        </button>
      </div>
      <div className="float-body">{children}</div>
    </div>
  );
}
