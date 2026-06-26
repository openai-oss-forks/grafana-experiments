import { act, render, screen } from '@testing-library/react';
import { ReactNode, useEffect } from 'react';

import { type SceneObject } from '@grafana/scenes';
import { useGraphNGRenderVisibility } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

import {
  DashboardPanelLazyLoader,
  FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY,
  GRAPHNG_RETENTION_MARGIN_VIEWPORTS,
  MIN_GRAPHNG_PREWARM_MARGIN,
} from './DashboardPanelLazyLoader';
import {
  PANEL_ACTIVATION_BUDGET,
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

  function createActivationTarget(isActive = false) {
    const isInViewChanged = jest.fn();
    const target = {
      isActive,
      state: { $data: { isInViewChanged } },
      subscribeToState: jest.fn(() => ({ unsubscribe: jest.fn() })),
    } as unknown as SceneObject;
    return { target, isInViewChanged };
  }

  function renderPanel(children: ReactNode, activationTarget?: SceneObject) {
    return render(
      <PanelLifecycleProvider>
        <DashboardPanelLazyLoader activationTarget={activationTarget}>{children}</DashboardPanelLazyLoader>
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

  test('uses shared observers and admits a lazy panel only through the coordinator', () => {
    const activationTarget = { isActive: false } as SceneObject;
    renderPanel(<PanelLifecycleProbe />, activationTarget);

    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
    expect(IntersectionObserver).toHaveBeenCalledTimes(3);
    expect(IntersectionObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: `${Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN)}px 0px`,
    });
    expect(IntersectionObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: `${
        Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN) * GRAPHNG_RETENTION_MARGIN_VIEWPORTS
      }px 0px`,
    });

    flushAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
  });

  test('waits for renderer preparation before mounting an admitted panel', () => {
    const { target } = createActivationTarget();
    renderPanel(<PanelLifecycleProbe />, target);

    flushNextAnimationFrame();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();

    flushNextAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
  });

  test('does not reuse lifecycle admission when the activation target changes', () => {
    const first = createActivationTarget();
    const second = createActivationTarget();
    const view = render(
      <PanelLifecycleProvider>
        <DashboardPanelLazyLoader activationTarget={first.target}>
          <PanelLifecycleProbe key="first" />
        </DashboardPanelLazyLoader>
      </PanelLifecycleProvider>
    );
    flushAnimationFrame();
    expect(onPanelMount).toHaveBeenCalledTimes(1);

    view.rerender(
      <PanelLifecycleProvider>
        <DashboardPanelLazyLoader activationTarget={second.target}>
          <PanelLifecycleProbe key="second" />
        </DashboardPanelLazyLoader>
      </PanelLifecycleProvider>
    );

    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    flushAnimationFrame();
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(onPanelMount).toHaveBeenCalledTimes(2);
  });

  test('keeps queries active through prefetch and pauses them outside it', () => {
    const { target, isInViewChanged } = createActivationTarget();
    renderPanel(<PanelLifecycleProbe />, target);
    flushAnimationFrame();
    expect(isInViewChanged).toHaveBeenLastCalledWith(true);

    act(() => callbacks.get('visible')?.(false));
    expect(isInViewChanged).toHaveBeenLastCalledWith(true);

    act(() => callbacks.get('prefetch')?.(false));
    expect(isInViewChanged).toHaveBeenLastCalledWith(false);

    act(() => callbacks.get('prefetch')?.(true));
    expect(isInViewChanged).toHaveBeenLastCalledWith(true);
  });

  test('retains the renderer inside the retention boundary and evicts it through the bounded queue', () => {
    renderPanel(<PanelLifecycleProbe />);
    flushAnimationFrame();

    act(() => callbacks.get('visible')?.(false));
    act(() => callbacks.get('prefetch')?.(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');

    act(() => callbacks.get('retention')?.(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    flushAnimationFrame();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).toHaveBeenCalledTimes(1);

    act(() => callbacks.get('prefetch')?.(true));
    flushAnimationFrame();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(2);
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
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
    expect(onPanelUnmount).toHaveBeenCalledTimes(1);
  });

  test('admits at most one activation budget per frame and prioritizes visible work', () => {
    const coordinator = new PanelLifecycleCoordinator();
    const snapshots: PanelLifecycleSnapshot[][] = Array.from({ length: PANEL_ACTIVATION_BUDGET + 1 }, () => []);
    const targets = Array.from({ length: PANEL_ACTIVATION_BUDGET + 1 }, () => ({ isActive: false }) as SceneObject);

    targets.forEach((target, index) => {
      const element = document.createElement('div');
      element.getBoundingClientRect = () =>
        ({
          top: index === targets.length - 1 ? 0 : window.innerHeight + 100,
          bottom: index === targets.length - 1 ? 100 : window.innerHeight + 101,
        }) as DOMRect;
      coordinator.register(element, target, (snapshot) => snapshots[index].push(snapshot));
    });

    flushAnimationFrame();
    const admitted = snapshots.map((values) => values.at(-1)?.activationAllowed ?? false);
    expect(admitted.filter(Boolean)).toHaveLength(PANEL_ACTIVATION_BUDGET);
    expect(admitted.at(-1)).toBe(true);

    flushAnimationFrame();
    expect(snapshots.every((values) => values.at(-1)?.activationAllowed)).toBe(true);
    coordinator.destroy();
  });
});
