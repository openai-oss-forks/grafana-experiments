import { act, fireEvent, render, screen } from '@testing-library/react';
import { ReactNode, Ref, useEffect } from 'react';

import { useGraphNGRenderVisibility } from 'app/core/components/GraphNG/GraphNGRenderVisibility';

import {
  DashboardPanelLazyLoader,
  DashboardPanelRenderSuspender,
  FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY,
  GRAPHNG_RETENTION_MARGIN_VIEWPORTS,
  MIN_GRAPHNG_PREWARM_MARGIN,
  OFFSCREEN_GRAPHNG_SUSPEND_DELAY,
} from './DashboardPanelLazyLoader';

let mockOnChange: (isInView: boolean) => void = () => {};
let mockOnRetentionChange: (isInView: boolean) => void = () => {};

jest.mock('@grafana/scenes', () => {
  const React = jest.requireActual('react');
  return {
    LazyLoader: React.forwardRef(
      (
        {
          children,
          renderBeforeActivation,
          ...props
        }: {
          children: ReactNode;
          renderBeforeActivation?: boolean;
          onFocusCapture?: () => void;
          onBlurCapture?: () => void;
        },
        ref: Ref<HTMLDivElement>
      ) => (
        <div ref={ref} data-render-before-activation={renderBeforeActivation || undefined} {...props}>
          {children}
        </div>
      )
    ),
  };
});

describe('DashboardPanelLazyLoader', () => {
  const onPanelMount = jest.fn();
  const onPanelUnmount = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    let observerIndex = 0;
    jest.spyOn(global, 'IntersectionObserver').mockImplementation((callback, options) => {
      const currentObserverIndex = observerIndex++;
      let target: Element = document.body;
      const observer: IntersectionObserver = {
        root: null,
        rootMargin: options?.rootMargin ?? '0px',
        thresholds: [],
        disconnect: jest.fn(),
        observe: jest.fn((element) => {
          target = element;
        }),
        takeRecords: jest.fn(() => []),
        unobserve: jest.fn(),
      };
      const onChange = (isIntersecting: boolean) => {
        const rect = target.getBoundingClientRect();
        callback(
          [
            {
              boundingClientRect: rect,
              intersectionRatio: isIntersecting ? 1 : 0,
              intersectionRect: rect,
              isIntersecting,
              rootBounds: null,
              target,
              time: 0,
            },
          ],
          observer
        );
      };
      if (currentObserverIndex === 0) {
        mockOnChange = onChange;
      } else {
        mockOnRetentionChange = onChange;
      }
      return observer;
    });
    jest.clearAllMocks();
    onPanelMount.mockClear();
    onPanelUnmount.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function PanelLifecycleProbe() {
    const graphNGRendererActive = useGraphNGRenderVisibility();

    useEffect(() => {
      onPanelMount();
      return () => {
        onPanelUnmount();
      };
    }, []);

    return (
      <div data-testid="panel" data-graphng-active={graphNGRendererActive}>
        panel
      </div>
    );
  }

  function FocusedControlProbe() {
    const graphNGRendererActive = useGraphNGRenderVisibility();
    return <button data-graphng-active={graphNGRendererActive}>focused control</button>;
  }

  test('renders the scene shell before activating lazy panel content', () => {
    const { container } = render(
      <DashboardPanelLazyLoader>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    expect(container.firstElementChild).toHaveAttribute('data-render-before-activation', 'true');
  });

  test('suspends GraphNG without unmounting the panel and restores it on reentry', () => {
    render(
      <DashboardPanelLazyLoader>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => mockOnChange(false));
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');

    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).not.toHaveBeenCalled();

    act(() => mockOnChange(true));
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).not.toHaveBeenCalled();
  });

  test('prewarms GraphNG by at least one viewport before reentry', () => {
    render(
      <DashboardPanelLazyLoader>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    expect(IntersectionObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: `${Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN)}px 0px`,
    });
    expect(IntersectionObserver).toHaveBeenCalledWith(expect.any(Function), {
      rootMargin: `${
        Math.max(window.innerHeight, MIN_GRAPHNG_PREWARM_MARGIN) * GRAPHNG_RETENTION_MARGIN_VIEWPORTS
      }px 0px`,
    });
  });

  test('shares the prewarm and retention observers across dashboard panels', () => {
    render(
      <>
        <DashboardPanelLazyLoader>
          <PanelLifecycleProbe />
        </DashboardPanelLazyLoader>
        <DashboardPanelLazyLoader>
          <PanelLifecycleProbe />
        </DashboardPanelLazyLoader>
      </>
    );

    expect(IntersectionObserver).toHaveBeenCalledTimes(2);
  });

  test('suspends far-away GraphNG quickly and prewarms it before reentry', () => {
    render(
      <DashboardPanelLazyLoader>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => mockOnChange(false));
    act(() => mockOnRetentionChange(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY - 1));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');

    act(() => jest.advanceTimersByTime(1));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');

    act(() => mockOnRetentionChange(true));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');

    act(() => mockOnChange(true));
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
  });

  test('keeps GraphNG active when offscreen suspension is disabled', () => {
    render(
      <DashboardPanelLazyLoader suspendGraphNGOffscreen={false}>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => mockOnChange(false));
    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY));

    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
  });

  test('cancels suspension when the panel returns during the grace period', () => {
    render(
      <DashboardPanelLazyLoader>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => mockOnChange(false));
    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY - 1));
    act(() => mockOnChange(true));
    act(() => jest.advanceTimersByTime(1));

    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).not.toHaveBeenCalled();
  });

  test('starts suspension when it is enabled while the panel is already offscreen', () => {
    const { rerender } = render(
      <DashboardPanelLazyLoader suspendGraphNGOffscreen={false}>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => mockOnChange(false));
    rerender(
      <DashboardPanelLazyLoader suspendGraphNGOffscreen={true}>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );
    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY));

    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).not.toHaveBeenCalled();
  });

  test('does not suspend while focus remains inside the panel', () => {
    render(
      <DashboardPanelLazyLoader>
        <FocusedControlProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => screen.getByRole('button').focus());
    act(() => mockOnChange(false));
    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY));

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveFocus();
    expect(screen.getByRole('button')).toHaveAttribute('data-graphng-active', 'true');
  });

  test('does not suspend a compact renderer while its tooltip is pinned', () => {
    render(
      <DashboardPanelLazyLoader>
        <PanelLifecycleProbe />
      </DashboardPanelLazyLoader>
    );
    const panel = screen.getByTestId('panel');
    panel.setAttribute('data-compact-tooltip-pinned', 'true');

    act(() => mockOnChange(false));
    act(() => mockOnRetentionChange(false));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));

    expect(panel).toHaveAttribute('data-graphng-active', 'true');

    panel.removeAttribute('data-compact-tooltip-pinned');
    act(() => panel.dispatchEvent(new CustomEvent('grafana-compact-tooltip-pin-change', { bubbles: true })));
    act(() => jest.advanceTimersByTime(FAR_OFFSCREEN_GRAPHNG_SUSPEND_DELAY));

    expect(panel).toHaveAttribute('data-graphng-active', 'false');
  });

  test('reactivates GraphNG when focus enters a suspended panel', () => {
    render(
      <DashboardPanelLazyLoader>
        <FocusedControlProbe />
      </DashboardPanelLazyLoader>
    );

    act(() => mockOnChange(false));
    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY));
    expect(screen.getByRole('button')).toHaveAttribute('data-graphng-active', 'false');

    act(() => screen.getByRole('button').focus());
    expect(screen.getByRole('button')).toHaveAttribute('data-graphng-active', 'true');
  });

  test('cancels deferred blur work when the panel wrapper unmounts', () => {
    const { container, unmount } = render(
      <DashboardPanelLazyLoader>
        <FocusedControlProbe />
      </DashboardPanelLazyLoader>
    );

    fireEvent.blur(container.firstElementChild!);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });

  test('suspends a preloaded renderer without lazy mounting the panel', () => {
    render(
      <DashboardPanelRenderSuspender>
        <PanelLifecycleProbe />
      </DashboardPanelRenderSuspender>
    );

    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'true');

    act(() => mockOnChange(false));
    act(() => jest.advanceTimersByTime(OFFSCREEN_GRAPHNG_SUSPEND_DELAY));

    expect(screen.getByTestId('panel')).toHaveAttribute('data-graphng-active', 'false');
    expect(onPanelMount).toHaveBeenCalledTimes(1);
    expect(onPanelUnmount).not.toHaveBeenCalled();
  });
});
