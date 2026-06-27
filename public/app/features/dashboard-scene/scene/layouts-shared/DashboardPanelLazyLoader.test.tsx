import { act, render, screen } from '@testing-library/react';
import { ReactNode, useEffect } from 'react';

import { useGraphNGRenderVisibility } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

import {
  DashboardPanelLazyLoader,
  FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY,
  GRAPHNG_RETENTION_MARGIN_VIEWPORTS,
  MIN_GRAPHNG_PREWARM_MARGIN,
} from './DashboardPanelLazyLoader';
import {
  PANEL_RENDER_PREPARATION_BUDGET,
  PanelLifecycleCoordinator,
  PanelLifecycleProvider,
  PanelLifecycleSnapshot,
} from './PanelLifecycleCoordinator';

type Boundary = 'visible' | 'prefetch' | 'retention';

describe('DashboardPanelLazyLoader', () => {
  const callbacks = new Map<Boundary, (isIntersecting: boolean) => void>();
  const animationFrames: FrameRequestCallback[] = [];
  const onPanelMount = jest.fn();
  const onPanelUnmount = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const intersectionObserver = jest.spyOn(global, 'IntersectionObserver').mockImplementation((callback, options) => {
      const margin = options?.rootMargin;
      const boundary: Boundary = !margin
        ? 'visible'
        : margin === `${Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN)}px 0px`
          ? 'prefetch'
          : 'retention';
      const targets = new Set<Element>();
      callbacks.set(boundary, (isIntersecting) => {
        callback(
          [...targets].map((target) => ({
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRatio: isIntersecting ? 1 : 0,
            intersectionRect: target.getBoundingClientRect(),
            isIntersecting,
            rootBounds: null,
            target,
            time: 0,
          })) as IntersectionObserverEntry[],
          observer
        );
      });
      const observer: IntersectionObserver = {
        root: null,
        rootMargin: margin ?? '0px',
        thresholds: [],
        disconnect: jest.fn(),
        observe: jest.fn((target) => targets.add(target)),
        takeRecords: jest.fn(() => []),
        unobserve: jest.fn((target) => targets.delete(target)),
      };
      return observer;
    });
    intersectionObserver.mockClear();
    callbacks.clear();
    animationFrames.length = 0;
    onPanelMount.mockClear();
    onPanelUnmount.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function flushAnimationFrame() {
    const callbacks = animationFrames.splice(0);
    act(() => callbacks.forEach((callback) => callback(performance.now())));
  }

  function flushNextAnimationFrame() {
    const callback = animationFrames.shift();
    act(() => callback?.(performance.now()));
  }

  function renderPanel(children: ReactNode) {
    return render(
      <PanelLifecycleProvider>
        <DashboardPanelLazyLoader>{children}</DashboardPanelLazyLoader>
      </PanelLifecycleProvider>
    );
  }

  function PanelLifecycleProbe() {
    const graphNGRendererActive = useGraphNGRenderVisibility();
    useEffect(() => {
      onPanelMount();
      return () => onPanelUnmount();
    }, []);
    return <div data-testid="panel" data-graphng-active={graphNGRendererActive} />;
  }

  test('keeps the lazy shell mounted while renderer work is admitted through shared observers', () => {
    renderPanel(<PanelLifecycleProbe />);

    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');
    expect(IntersectionObserver).toHaveBeenCalledTimes(3);
    expect(IntersectionObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: `${Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN)}px 0px`,
    });
    expect(IntersectionObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: `${
        Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN) * GRAPHNG_RETENTION_MARGIN_VIEWPORTS
      }px 0px`,
    });

    flushNextAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
  });

  test('suspends the renderer without unmounting the panel', () => {
    renderPanel(<PanelLifecycleProbe />);
    flushAnimationFrame();

    act(() => callbacks.get('visible')?.(false));
    act(() => callbacks.get('prefetch')?.(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');

    act(() => callbacks.get('retention')?.(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    flushAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).not.toHaveBeenCalled();

    act(() => callbacks.get('prefetch')?.(true));
    flushAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
  });

  test('retains an interactive panel outside the retention boundary', () => {
    renderPanel(<PanelLifecycleProbe />);
    flushAnimationFrame();
    const panel = screen.getByTestId('panel');
    panel.setAttribute('data-compact-tooltip-pinned', 'true');
    act(() => panel.dispatchEvent(new CustomEvent('grafana-compact-tooltip-pin-change', { bubbles: true })));
    act(() => callbacks.get('visible')?.(false));
    act(() => callbacks.get('prefetch')?.(false));
    act(() => callbacks.get('retention')?.(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    flushAnimationFrame();
    expect(panel).toHaveAttribute('data-graphng-active', 'true');

    panel.removeAttribute('data-compact-tooltip-pinned');
    act(() => panel.dispatchEvent(new CustomEvent('grafana-compact-tooltip-pin-change', { bubbles: true })));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    flushAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');
    expect(onPanelUnmount).not.toHaveBeenCalled();
  });

  test('prepares only the renderer budget per frame and prioritizes visible work', () => {
    const coordinator = new PanelLifecycleCoordinator();
    const snapshots: PanelLifecycleSnapshot[][] = Array.from({ length: PANEL_RENDER_PREPARATION_BUDGET + 1 }, () => []);

    snapshots.forEach((values, index) => {
      const element = document.createElement('div');
      element.getBoundingClientRect = () =>
        ({
          top: index === snapshots.length - 1 ? 0 : window.innerHeight + 100,
          bottom: index === snapshots.length - 1 ? 100 : window.innerHeight + 101,
        }) as DOMRect;
      coordinator.register(element, (snapshot) => values.push(snapshot));
    });

    flushNextAnimationFrame();
    const prepared = snapshots.map((values) => values.at(-1)?.rendererActive ?? false);
    expect(prepared.filter(Boolean)).toHaveLength(PANEL_RENDER_PREPARATION_BUDGET);
    expect(prepared.at(-1)).toBe(true);

    flushNextAnimationFrame();
    expect(snapshots.every((values) => values.at(-1)?.rendererActive)).toBe(true);
    coordinator.destroy();
  });
});
