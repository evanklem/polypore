import React, { useCallback, useEffect, useRef, useState } from 'react';

export type ResizeHandleProps = {
  axis: 'x' | 'y';
  label: string;
  onDrag: (event: PointerEvent, handle: HTMLDivElement) => void;
  onDragEnd?: () => void;
};

export type ResizableSplitOptions = {
  axis: 'x' | 'y';
  initial: number;
  min: number;
  max: number;
};

export function useResizableSplit({ axis, initial, min, max }: ResizableSplitOptions) {
  const [size, setSize] = useState(initial);

  const onDrag = useCallback((event: PointerEvent, handle: HTMLDivElement) => {
    const bounds = handle.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const total = axis === 'x' ? bounds.width : bounds.height;
    if (total <= 0) return;
    const offset = axis === 'x' ? event.clientX - bounds.left : event.clientY - bounds.top;
    const next = (offset / total) * 100;
    setSize(Math.min(max, Math.max(min, next)));
  }, [axis, max, min]);

  return [size, onDrag, setSize] as const;
}

export function ResizeHandle({ axis, label, onDrag, onDragEnd }: ResizeHandleProps) {
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const dragRef = useRef<{
    handle: HTMLDivElement;
    latestEvent: PointerEvent;
    frame: number | null;
  } | null>(null);

  useEffect(() => {
    onDragRef.current = onDrag;
    onDragEndRef.current = onDragEnd;
  }, [onDrag, onDragEnd]);

  const clearFrame = useCallback(() => {
    const drag = dragRef.current;
    if (drag && drag.frame !== null) {
      cancelAnimationFrame(drag.frame);
      drag.frame = null;
    }
  }, []);

  const move = useCallback((moveEvent: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    moveEvent.preventDefault();
    drag.latestEvent = moveEvent;
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      const current = dragRef.current;
      if (!current) return;
      current.frame = null;
      onDragRef.current(current.latestEvent, current.handle);
    });
  }, []);

  const stopDrag = useCallback(() => {
    const wasDragging = dragRef.current !== null;
    clearFrame();
    dragRef.current = null;
    delete document.body.dataset.dvResizing;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stopDrag, true);
    window.removeEventListener('pointercancel', stopDrag, true);
    window.removeEventListener('blur', stopDrag, true);
    if (wasDragging) onDragEndRef.current?.();
  }, [clearFrame, move]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* The pointer can already be released in some embedded-webview edge
         cases. Global listeners below still keep the drag path intact. */
    }

    clearFrame();
    document.body.dataset.dvResizing = axis;
    dragRef.current = {
      handle,
      latestEvent: event.nativeEvent,
      frame: null,
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', stopDrag, true);
    window.addEventListener('pointercancel', stopDrag, true);
    window.addEventListener('blur', stopDrag, true);
  };

  useEffect(() => stopDrag, [stopDrag]);

  return (
    <div
      className={`resize-handle resize-handle--${axis}`}
      aria-label={label}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={beginDrag}
    />
  );
}
