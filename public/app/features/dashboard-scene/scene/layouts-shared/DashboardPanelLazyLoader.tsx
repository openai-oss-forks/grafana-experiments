import { ForwardedRef, forwardRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { LazyLoader } from '@grafana/scenes';
import { GraphNGRenderVisibilityProvider } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

export const OFFSCREEN_GRAPHNG_SUSPEND_DELAY = 60_000;
export const MIN_GRAPHNG_PREWARM_MARGIN = 800;

const graphNGVisibilityCallbacks = new Map<Element, (isIntersecting: boolean) => void>();
let graphNGVisibilityObserver: IntersectionObserver | undefined;

function observeGraphNGVisibility(element: Element, callback: (isIntersecting: boolean) => void): () => void {
  if (!graphNGVisibilityObserver) {
    graphNGVisibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          graphNGVisibilityCallbacks.get(entry.target)?.(entry.isIntersecting);
        }
      },
      { rootMargin: `${Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN)}px 0px` }
    );
  }

  graphNGVisibilityCallbacks.set(element, callback);
  graphNGVisibilityObserver.observe(element);

  return () => {
    graphNGVisibilityObserver?.unobserve(element);
    graphNGVisibilityCallbacks.delete(element);
    if (graphNGVisibilityCallbacks.size === 0) {
      graphNGVisibilityObserver?.disconnect();
      graphNGVisibilityObserver = undefined;
    }
  };
}

interface DashboardPanelRenderSuspensionProps {
  children: ReactNode;
  className?: string;
  suspendGraphNGOffscreen?: boolean;
  onRenderMarginChange?: (isWithinRenderMargin: boolean) => void;
}

interface GraphNGRenderSuspensionState {
  graphNGRendererActive: boolean;
  setWrapperRef: (element: HTMLDivElement | null) => void;
  onBlurCapture: () => void;
  onFocusCapture: () => void;
}

function useGraphNGRenderSuspension(
  suspendGraphNGOffscreen: boolean,
  onRenderMarginChange: ((isWithinRenderMargin: boolean) => void) | undefined,
  ref: ForwardedRef<HTMLDivElement>
): GraphNGRenderSuspensionState {
  const [graphNGRendererActive, setGraphNGRendererActive] = useState(true);
  const suspendTimer = useRef<number>();
  const isWithinRenderMargin = useRef(true);
  const suspensionEnabled = useRef(suspendGraphNGOffscreen);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const onRenderMarginChangeRef = useRef(onRenderMarginChange);
  onRenderMarginChangeRef.current = onRenderMarginChange;

  const clearSuspendTimer = useCallback(() => {
    if (suspendTimer.current !== undefined) {
      window.clearTimeout(suspendTimer.current);
      suspendTimer.current = undefined;
    }
  }, []);

  useEffect(() => clearSuspendTimer, [clearSuspendTimer]);

  const updateRendererActivity = useCallback(
    (inView: boolean) => {
      clearSuspendTimer();

      if (inView || !suspensionEnabled.current) {
        setGraphNGRendererActive(true);
        return;
      }

      suspendTimer.current = window.setTimeout(() => {
        suspendTimer.current = undefined;
        if (wrapper.current?.contains(document.activeElement)) {
          return;
        }
        setGraphNGRendererActive(false);
      }, OFFSCREEN_GRAPHNG_SUSPEND_DELAY);
    },
    [clearSuspendTimer]
  );

  useEffect(() => {
    suspensionEnabled.current = suspendGraphNGOffscreen;
    updateRendererActivity(isWithinRenderMargin.current);
  }, [suspendGraphNGOffscreen, updateRendererActivity]);

  const setWrapperRef = useCallback(
    (element: HTMLDivElement | null) => {
      wrapper.current = element;
      if (typeof ref === 'function') {
        ref(element);
      } else if (ref) {
        ref.current = element;
      }
    },
    [ref]
  );

  useEffect(() => {
    const element = wrapper.current;
    if (!element) {
      return;
    }

    return observeGraphNGVisibility(element, (isIntersecting) => {
      isWithinRenderMargin.current = isIntersecting;
      onRenderMarginChangeRef.current?.(isIntersecting);
      updateRendererActivity(isIntersecting);
    });
  }, [updateRendererActivity]);

  const onBlurCapture = useCallback(() => {
    window.setTimeout(() => {
      if (!isWithinRenderMargin.current) {
        onRenderMarginChangeRef.current?.(false);
      }
      updateRendererActivity(isWithinRenderMargin.current);
    }, 0);
  }, [updateRendererActivity]);

  const onFocusCapture = useCallback(() => {
    clearSuspendTimer();
    onRenderMarginChangeRef.current?.(true);
    setGraphNGRendererActive(true);
  }, [clearSuspendTimer]);

  return { graphNGRendererActive, setWrapperRef, onBlurCapture, onFocusCapture };
}

export const DashboardPanelLazyLoader = forwardRef<HTMLDivElement, DashboardPanelRenderSuspensionProps>(
  ({ children, className, suspendGraphNGOffscreen = true, onRenderMarginChange }, ref) => {
    const { graphNGRendererActive, setWrapperRef, onBlurCapture, onFocusCapture } = useGraphNGRenderSuspension(
      suspendGraphNGOffscreen,
      onRenderMarginChange,
      ref
    );

    return (
      <LazyLoader
        key="dashboard-panel-lazy-loader"
        ref={setWrapperRef}
        className={className}
        onFocusCapture={onFocusCapture}
        onBlurCapture={onBlurCapture}
      >
        <GraphNGRenderVisibilityProvider active={graphNGRendererActive}>{children}</GraphNGRenderVisibilityProvider>
      </LazyLoader>
    );
  }
);

DashboardPanelLazyLoader.displayName = 'DashboardPanelLazyLoader';

export const DashboardPanelRenderSuspender = forwardRef<HTMLDivElement, DashboardPanelRenderSuspensionProps>(
  ({ children, className, suspendGraphNGOffscreen = true, onRenderMarginChange }, ref) => {
    const { graphNGRendererActive, setWrapperRef, onBlurCapture, onFocusCapture } = useGraphNGRenderSuspension(
      suspendGraphNGOffscreen,
      onRenderMarginChange,
      ref
    );

    return (
      <div ref={setWrapperRef} className={className} onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>
        <GraphNGRenderVisibilityProvider active={graphNGRendererActive}>{children}</GraphNGRenderVisibilityProvider>
      </div>
    );
  }
);

DashboardPanelRenderSuspender.displayName = 'DashboardPanelRenderSuspender';
