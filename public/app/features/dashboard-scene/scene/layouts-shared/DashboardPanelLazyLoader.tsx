import { ForwardedRef, forwardRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { LazyLoader } from '@grafana/scenes';
import { GraphNGRenderVisibilityProvider } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

export const OFFSCREEN_GRAPHNG_SUSPEND_DELAY = 60_000;
export const FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY = 1_000;
export const MIN_GRAPHNG_PREWARM_MARGIN = 800;
export const GRAPHNG_RETENTION_MARGIN_VIEWPORTS = 4;

const graphNGVisibilityCallbacks = new Map<Element, (isIntersecting: boolean) => void>();
const graphNGRetentionCallbacks = new Map<Element, (isIntersecting: boolean) => void>();
let graphNGVisibilityObserver: IntersectionObserver | undefined;
let graphNGRetentionObserver: IntersectionObserver | undefined;

function observeGraphNGVisibility(
  element: Element,
  visibilityCallback: (isIntersecting: boolean) => void,
  retentionCallback: (isIntersecting: boolean) => void
): () => void {
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
  if (!graphNGRetentionObserver) {
    graphNGRetentionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          graphNGRetentionCallbacks.get(entry.target)?.(entry.isIntersecting);
        }
      },
      {
        rootMargin: `${Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN) * GRAPHNG_RETENTION_MARGIN_VIEWPORTS}px 0px`,
      }
    );
  }

  graphNGVisibilityCallbacks.set(element, visibilityCallback);
  graphNGRetentionCallbacks.set(element, retentionCallback);
  graphNGVisibilityObserver.observe(element);
  graphNGRetentionObserver.observe(element);

  return () => {
    graphNGVisibilityObserver?.unobserve(element);
    graphNGRetentionObserver?.unobserve(element);
    graphNGVisibilityCallbacks.delete(element);
    graphNGRetentionCallbacks.delete(element);
    if (graphNGVisibilityCallbacks.size === 0) {
      graphNGVisibilityObserver?.disconnect();
      graphNGVisibilityObserver = undefined;
    }
    if (graphNGRetentionCallbacks.size === 0) {
      graphNGRetentionObserver?.disconnect();
      graphNGRetentionObserver = undefined;
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
  const isWithinRetentionMargin = useRef(true);
  const rendererActive = useRef(true);
  onRenderMarginChangeRef.current = onRenderMarginChange;

  const clearSuspendTimer = useCallback(() => {
    if (suspendTimer.current !== undefined) {
      window.clearTimeout(suspendTimer.current);
      suspendTimer.current = undefined;
    }
  }, []);

  useEffect(() => clearSuspendTimer, [clearSuspendTimer]);

  const setRendererActive = useCallback((active: boolean) => {
    rendererActive.current = active;
    setGraphNGRendererActive(active);
  }, []);

  const updateRendererActivity = useCallback(() => {
    clearSuspendTimer();

    if (isWithinRenderMargin.current || !suspensionEnabled.current) {
      setRendererActive(true);
      return;
    }
    if (!rendererActive.current) {
      return;
    }

    const delay = isWithinRetentionMargin.current
      ? OFFSCREEN_GRAPHNG_SUSPEND_DELAY
      : FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY;
    suspendTimer.current = window.setTimeout(() => {
      suspendTimer.current = undefined;
      if (wrapper.current?.contains(document.activeElement)) {
        return;
      }
      setRendererActive(false);
    }, delay);
  }, [clearSuspendTimer, setRendererActive]);

  useEffect(() => {
    suspensionEnabled.current = suspendGraphNGOffscreen;
    updateRendererActivity();
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

    return observeGraphNGVisibility(
      element,
      (isIntersecting) => {
        isWithinRenderMargin.current = isIntersecting;
        onRenderMarginChangeRef.current?.(isIntersecting);
        updateRendererActivity();
      },
      (isIntersecting) => {
        isWithinRetentionMargin.current = isIntersecting;
        updateRendererActivity();
      }
    );
  }, [updateRendererActivity]);

  const onBlurCapture = useCallback(() => {
    window.setTimeout(() => {
      if (!isWithinRenderMargin.current) {
        onRenderMarginChangeRef.current?.(false);
      }
      updateRendererActivity();
    }, 0);
  }, [updateRendererActivity]);

  const onFocusCapture = useCallback(() => {
    clearSuspendTimer();
    onRenderMarginChangeRef.current?.(true);
    setRendererActive(true);
  }, [clearSuspendTimer, setRendererActive]);

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
