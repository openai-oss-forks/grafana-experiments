import { ForwardedRef, forwardRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { LazyLoader } from '@grafana/scenes';
import { GraphNGRenderVisibilityProvider } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

export const OFFSCREEN_GRAPHNG_SUSPEND_DELAY = 60_000;
export const FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY = 1_000;
export const MIN_GRAPHNG_PREWARM_MARGIN = 800;
export const GRAPHNG_RETENTION_MARGIN_VIEWPORTS = 2;
const COMPACT_TOOLTIP_PIN_CHANGE_EVENT = 'grafana-compact-tooltip-pin-change';
const COMPACT_TOOLTIP_PINNED_SELECTOR = '[data-compact-tooltip-pinned="true"]';

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
}

interface GraphNGRenderSuspensionState {
  graphNGRendererActive: boolean;
  setWrapperRef: (element: HTMLDivElement | null) => void;
  onBlurCapture: () => void;
  onFocusCapture: () => void;
}

function useGraphNGRenderSuspension(
  suspendGraphNGOffscreen: boolean,
  ref: ForwardedRef<HTMLDivElement>
): GraphNGRenderSuspensionState {
  const [graphNGRendererActive, setGraphNGRendererActive] = useState(true);
  const suspendTimer = useRef<number>();
  const blurTimer = useRef<number>();
  const isWithinRenderMargin = useRef(true);
  const suspensionEnabled = useRef(suspendGraphNGOffscreen);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const isWithinRetentionMargin = useRef(true);
  const rendererActive = useRef(true);

  const clearSuspendTimer = useCallback(() => {
    if (suspendTimer.current !== undefined) {
      window.clearTimeout(suspendTimer.current);
      suspendTimer.current = undefined;
    }
  }, []);

  const clearBlurTimer = useCallback(() => {
    if (blurTimer.current !== undefined) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = undefined;
    }
  }, []);

  useEffect(
    () => () => {
      clearSuspendTimer();
      clearBlurTimer();
    },
    [clearBlurTimer, clearSuspendTimer]
  );

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
      if (
        wrapper.current?.contains(document.activeElement) ||
        wrapper.current?.querySelector(COMPACT_TOOLTIP_PINNED_SELECTOR)
      ) {
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
        updateRendererActivity();
      },
      (isIntersecting) => {
        isWithinRetentionMargin.current = isIntersecting;
        updateRendererActivity();
      }
    );
  }, [updateRendererActivity]);

  useEffect(() => {
    const element = wrapper.current;
    if (!element) {
      return;
    }
    element.addEventListener(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, updateRendererActivity);
    return () => element.removeEventListener(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, updateRendererActivity);
  }, [updateRendererActivity]);

  const onBlurCapture = useCallback(() => {
    clearBlurTimer();
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = undefined;
      updateRendererActivity();
    }, 0);
  }, [clearBlurTimer, updateRendererActivity]);

  const onFocusCapture = useCallback(() => {
    clearBlurTimer();
    clearSuspendTimer();
    setRendererActive(true);
  }, [clearBlurTimer, clearSuspendTimer, setRendererActive]);

  return { graphNGRendererActive, setWrapperRef, onBlurCapture, onFocusCapture };
}

export const DashboardPanelLazyLoader = forwardRef<HTMLDivElement, DashboardPanelRenderSuspensionProps>(
  ({ children, className, suspendGraphNGOffscreen = true }, ref) => {
    const { graphNGRendererActive, setWrapperRef, onBlurCapture, onFocusCapture } = useGraphNGRenderSuspension(
      suspendGraphNGOffscreen,
      ref
    );

    return (
      <LazyLoader
        key="dashboard-panel-lazy-loader"
        ref={setWrapperRef}
        className={className}
        renderBeforeActivation
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
  ({ children, className, suspendGraphNGOffscreen = true }, ref) => {
    const { graphNGRendererActive, setWrapperRef, onBlurCapture, onFocusCapture } = useGraphNGRenderSuspension(
      suspendGraphNGOffscreen,
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
