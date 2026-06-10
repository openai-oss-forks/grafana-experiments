import { type RefObject, useCallback, useLayoutEffect, useMemo, useState } from 'react';

export interface FixedVirtualItem {
  readonly index: number;
  readonly start: number;
}

interface FixedVirtualWindowOptions {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly count: number;
  readonly itemSize: number;
  readonly overscan: number;
  readonly horizontal?: boolean;
  readonly initialViewportSize?: number;
  readonly enabled?: boolean;
}

interface VirtualMetrics {
  readonly offset: number;
  readonly viewportSize: number;
}

export function useFixedVirtualWindow({
  containerRef,
  count,
  itemSize,
  overscan,
  horizontal = false,
  initialViewportSize = 0,
  enabled = true,
}: FixedVirtualWindowOptions) {
  const [metrics, setMetrics] = useState<VirtualMetrics>({
    offset: 0,
    viewportSize: initialViewportSize,
  });

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const update = () => {
      const measuredViewportSize = horizontal ? container.clientWidth : container.clientHeight;
      const next = {
        offset: horizontal ? container.scrollLeft : container.scrollTop,
        viewportSize: measuredViewportSize || initialViewportSize,
      };
      setMetrics((previous) =>
        previous.offset === next.offset && previous.viewportSize === next.viewportSize ? previous : next
      );
    };

    update();
    container.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      container.removeEventListener('scroll', update);
    };
  }, [containerRef, enabled, horizontal, initialViewportSize]);

  const viewportSize = metrics.viewportSize || initialViewportSize;
  const totalSize = Math.max(0, count * itemSize);
  const maxOffset = Math.max(0, totalSize - viewportSize);
  const effectiveOffset = Math.min(metrics.offset, maxOffset);

  useLayoutEffect(() => {
    if (!enabled || metrics.offset <= maxOffset) {
      return;
    }
    const container = containerRef.current;
    if (container) {
      if (horizontal) {
        container.scrollLeft = maxOffset;
      } else {
        container.scrollTop = maxOffset;
      }
    }
    setMetrics((previous) => (previous.offset === maxOffset ? previous : { ...previous, offset: maxOffset }));
  }, [containerRef, enabled, horizontal, maxOffset, metrics.offset]);

  const virtualItems = useMemo(() => {
    if (!enabled || count === 0 || itemSize <= 0 || viewportSize <= 0) {
      return [];
    }

    const first = Math.max(0, Math.floor(effectiveOffset / itemSize) - overscan);
    const end = Math.min(count, Math.ceil((effectiveOffset + viewportSize) / itemSize) + overscan);
    const items = new Array<FixedVirtualItem>(Math.max(0, end - first));
    for (let index = first; index < end; index++) {
      items[index - first] = { index, start: index * itemSize };
    }
    return items;
  }, [count, effectiveOffset, enabled, itemSize, overscan, viewportSize]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const container = containerRef.current;
      if (!container || count === 0) {
        return;
      }
      const boundedIndex = Math.max(0, Math.min(count - 1, index));
      const itemStart = boundedIndex * itemSize;
      const itemEnd = itemStart + itemSize;
      const offset = horizontal ? container.scrollLeft : container.scrollTop;
      const size = horizontal ? container.clientWidth : container.clientHeight;
      const nextOffset = itemStart < offset ? itemStart : itemEnd > offset + size ? itemEnd - size : offset;
      if (nextOffset === offset) {
        return;
      }
      if (horizontal) {
        container.scrollLeft = nextOffset;
      } else {
        container.scrollTop = nextOffset;
      }
      setMetrics((previous) => ({ ...previous, offset: nextOffset }));
    },
    [containerRef, count, horizontal, itemSize]
  );

  return {
    totalSize,
    virtualItems,
    scrollToIndex,
  };
}
