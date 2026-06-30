import { ForwardedRef, forwardRef, ReactNode, useCallback, useEffect, useRef } from 'react';

import { LazyLoader, type SceneObject } from '@grafana/scenes';
import { GraphNGRenderVisibilityProvider } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

import {
  PANEL_EVICTION_GRACE_MS,
  PANEL_PREFETCH_MIN_MARGIN,
  PANEL_RETENTION_VIEWPORTS,
  usePanelLifecycleRegistration,
} from './PanelLifecycleCoordinator';

export const OFFSCREEN_GRAPHNG_SUSPEND_DELAY = PANEL_EVICTION_GRACE_MS;
export const FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY = PANEL_EVICTION_GRACE_MS;
export const MIN_GRAPHNG_PREWARM_MARGIN = PANEL_PREFETCH_MIN_MARGIN;
export const GRAPHNG_RETENTION_MARGIN_VIEWPORTS = PANEL_RETENTION_VIEWPORTS;

const COMPACT_TOOLTIP_PIN_CHANGE_EVENT = 'grafana-compact-tooltip-pin-change';
const COMPACT_TOOLTIP_PINNED_SELECTOR = '[data-compact-tooltip-pinned="true"]';

interface DashboardPanelRenderSuspensionProps {
  children: ReactNode;
  className?: string;
  suspendGraphNGOffscreen?: boolean;
}

interface DashboardPanelLazyLoaderProps extends DashboardPanelRenderSuspensionProps {
  activationTarget?: SceneObject;
}

interface PanelLifecycleRenderState {
  graphNGRendererActive: boolean;
  setWrapperRef: (element: HTMLDivElement | null) => void;
  onBlurCapture: () => void;
  onFocusCapture: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function usePanelLifecycleRenderState(
  suspendGraphNGOffscreen: boolean,
  ref: ForwardedRef<HTMLDivElement>
): PanelLifecycleRenderState {
  const { snapshot, setElement, setInteractive } = usePanelLifecycleRegistration();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const blurTimer = useRef<number>();
  const hovered = useRef(false);
  const focused = useRef(false);

  const updateInteraction = useCallback(() => {
    const pinned = Boolean(wrapper.current?.querySelector(COMPACT_TOOLTIP_PINNED_SELECTOR));
    setInteractive(hovered.current || focused.current || pinned);
  }, [setInteractive]);

  const setWrapperRef = useCallback(
    (element: HTMLDivElement | null) => {
      wrapper.current = element;
      setElement(element);
      if (typeof ref === 'function') {
        ref(element);
      } else if (ref) {
        ref.current = element;
      }
    },
    [ref, setElement]
  );

  useEffect(() => {
    const element = wrapper.current;
    if (!element) {
      return;
    }
    element.addEventListener(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, updateInteraction);
    return () => element.removeEventListener(COMPACT_TOOLTIP_PIN_CHANGE_EVENT, updateInteraction);
  }, [updateInteraction]);

  useEffect(
    () => () => {
      if (blurTimer.current !== undefined) {
        window.clearTimeout(blurTimer.current);
      }
    },
    []
  );

  const onFocusCapture = useCallback(() => {
    focused.current = true;
    updateInteraction();
  }, [updateInteraction]);

  const onBlurCapture = useCallback(() => {
    if (blurTimer.current !== undefined) {
      window.clearTimeout(blurTimer.current);
    }
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = undefined;
      focused.current = Boolean(wrapper.current?.contains(document.activeElement));
      updateInteraction();
    }, 0);
  }, [updateInteraction]);

  const onMouseEnter = useCallback(() => {
    hovered.current = true;
    updateInteraction();
  }, [updateInteraction]);

  const onMouseLeave = useCallback(() => {
    hovered.current = false;
    updateInteraction();
  }, [updateInteraction]);

  return {
    graphNGRendererActive: suspendGraphNGOffscreen ? snapshot.rendererActive : true,
    setWrapperRef,
    onBlurCapture,
    onFocusCapture,
    onMouseEnter,
    onMouseLeave,
  };
}

export const DashboardPanelLazyLoader = forwardRef<HTMLDivElement, DashboardPanelLazyLoaderProps>(
  ({ activationTarget, children, className, suspendGraphNGOffscreen = true }, ref) => {
    const lifecycle = usePanelLifecycleRenderState(suspendGraphNGOffscreen, ref);

    return (
      <LazyLoader
        key="dashboard-panel-lazy-loader"
        ref={lifecycle.setWrapperRef}
        className={className}
        activationTarget={activationTarget}
        onFocusCapture={lifecycle.onFocusCapture}
        onBlurCapture={lifecycle.onBlurCapture}
        onMouseEnter={lifecycle.onMouseEnter}
        onMouseLeave={lifecycle.onMouseLeave}
      >
        <GraphNGRenderVisibilityProvider active={lifecycle.graphNGRendererActive}>
          {children}
        </GraphNGRenderVisibilityProvider>
      </LazyLoader>
    );
  }
);

DashboardPanelLazyLoader.displayName = 'DashboardPanelLazyLoader';

export const DashboardPanelRenderSuspender = forwardRef<HTMLDivElement, DashboardPanelRenderSuspensionProps>(
  ({ children, className, suspendGraphNGOffscreen = true }, ref) => {
    const lifecycle = usePanelLifecycleRenderState(suspendGraphNGOffscreen, ref);

    return (
      <div
        ref={lifecycle.setWrapperRef}
        className={className}
        onFocusCapture={lifecycle.onFocusCapture}
        onBlurCapture={lifecycle.onBlurCapture}
        onMouseEnter={lifecycle.onMouseEnter}
        onMouseLeave={lifecycle.onMouseLeave}
      >
        <GraphNGRenderVisibilityProvider active={lifecycle.graphNGRendererActive}>
          {children}
        </GraphNGRenderVisibilityProvider>
      </div>
    );
  }
);

DashboardPanelRenderSuspender.displayName = 'DashboardPanelRenderSuspender';
