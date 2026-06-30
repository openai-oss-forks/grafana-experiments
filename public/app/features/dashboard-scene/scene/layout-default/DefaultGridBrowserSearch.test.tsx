import { act, render, screen, waitFor } from '@testing-library/react';

import { getDefaultTimeRange, LoadingState } from '@grafana/data';
import { getPanelPlugin } from '@grafana/data/test';
import { setPluginImportUtils } from '@grafana/runtime';
import {
  LazyLoader,
  SceneGridLayout,
  SceneGridRow,
  SceneObjectBase,
  type SceneObjectState,
  SceneQueryRunner,
  type SceneComponentProps,
  VizPanel,
} from '@grafana/scenes';

import { DashboardScene } from '../DashboardScene';

import { DashboardGridItem } from './DashboardGridItem';
import { DefaultGridLayoutManager } from './DefaultGridLayoutManager';

const pluginId = 'browser-search-test-panel';
const panelPlugin = getPanelPlugin({ id: pluginId, skipDataQuery: false }, () => (
  <div data-testid="loaded-panel-visualization" />
));
let resolvePanelPlugin: (plugin: typeof panelPlugin) => void = () => {};

setPluginImportUtils({
  importPanelPlugin: () =>
    new Promise<typeof panelPlugin>((resolve) => {
      resolvePanelPlugin = resolve;
    }),
  getPanelPluginFromCache: () => undefined,
});

interface TestSceneObjectState extends SceneObjectState {
  child?: TestSceneObject;
  name: string;
}

class TestSceneObject extends SceneObjectBase<TestSceneObjectState> {
  public static Component = ({ model }: SceneComponentProps<TestSceneObject>) => {
    const { child, name } = model.useState();
    return <div data-testid={name}>{child && <child.Component model={child} />}</div>;
  };

  public constructor(name = 'default-lazy-child', child?: TestSceneObject, onActivate?: (name: string) => void) {
    super({ child, name });
    if (onActivate) {
      this.addActivationHandler(() => onActivate(name));
    }
  }
}

describe('default grid browser search', () => {
  const originalObserver = LazyLoader.observer;

  beforeEach(() => {
    LazyLoader.observer = {
      root: null,
      rootMargin: '100px',
      thresholds: [],
      disconnect: jest.fn(),
      observe: jest.fn(),
      takeRecords: jest.fn(() => []),
      unobserve: jest.fn(),
    };
  });

  afterEach(() => {
    LazyLoader.observer = originalObserver;
  });

  function enterViewport(element: HTMLElement) {
    act(() => {
      LazyLoader.callbacks[element.id]?.({
        isIntersecting: true,
        target: element,
      } as unknown as IntersectionObserverEntry);
    });
  }

  function getContainingLazyLoader(element: HTMLElement): HTMLElement | undefined {
    let ancestor = element.parentElement;
    while (ancestor && !LazyLoader.callbacks[ancestor.id]) {
      ancestor = ancestor.parentElement;
    }
    return ancestor ?? undefined;
  }

  function renderLazyDashboard(isCollapsed = false) {
    const queryRunner = new SceneQueryRunner({
      queries: [{ refId: 'A' }],
      runQueriesMode: 'manual',
      _hasFetchedData: true,
      data: { state: LoadingState.Done, series: [], timeRange: getDefaultTimeRange() },
    });
    const dataSubscriptionSpy = jest.spyOn(queryRunner, 'subscribeToState');
    const panel = new VizPanel({
      key: 'panel-1',
      pluginId,
      title: 'Persistent panel title',
      $data: queryRunner,
    });
    const gridItem = new DashboardGridItem({
      key: 'grid-item-1',
      x: 0,
      y: 2,
      width: 12,
      height: 8,
      body: panel,
    });
    const row = new SceneGridRow({
      key: 'row-1',
      y: 0,
      title: 'Persistent section title',
      renderBeforeActivation: true,
      isCollapsed,
      children: [gridItem],
    });
    const grid = new SceneGridLayout({ isLazy: true, children: [row] });

    new DashboardScene({ body: new DefaultGridLayoutManager({ grid }) });

    const GridComponent = grid.Component;
    const result = render(<GridComponent model={grid} />);

    return { ...result, dataSubscriptionSpy, gridItem, panel, queryRunner, row };
  }

  it('preserves the default LazyLoader mounting behavior for callers that do not opt in', async () => {
    const model = new TestSceneObject();
    const Component = model.Component;
    const { container } = render(
      <LazyLoader key="default-lazy-loader">
        <Component model={model} />
      </LazyLoader>
    );
    const loader = container.firstElementChild;

    expect(loader).toBeInstanceOf(HTMLElement);
    expect(model.isActive).toBe(false);
    expect(screen.queryByTestId('default-lazy-child')).not.toBeInTheDocument();

    enterViewport(loader as HTMLElement);

    await waitFor(() => expect(model.isActive).toBe(true));
    expect(screen.getByTestId('default-lazy-child')).toBeInTheDocument();
  });

  it('activates only the target at the lazy boundary, then activates its descendants', async () => {
    const activationOrder: string[] = [];
    const recordActivation = (name: string) => {
      activationOrder.push(name);
    };
    const child = new TestSceneObject('nested-lazy-child', undefined, recordActivation);
    const target = new TestSceneObject('target-lazy-child', child, recordActivation);
    const Component = target.Component;
    const { container } = render(
      <LazyLoader key="targeted-lazy-loader" activationTarget={target}>
        <Component model={target} />
      </LazyLoader>
    );
    const loader = container.firstElementChild;

    expect(loader).toBeInstanceOf(HTMLElement);
    expect(screen.getByTestId('target-lazy-child')).toBeInTheDocument();
    expect(screen.queryByTestId('nested-lazy-child')).not.toBeInTheDocument();
    expect(target.isActive).toBe(false);
    expect(child.isActive).toBe(false);

    enterViewport(loader as HTMLElement);

    await waitFor(() => expect(child.isActive).toBe(true));
    expect(target.isActive).toBe(true);
    expect(screen.getByTestId('nested-lazy-child')).toBeInTheDocument();
    expect(activationOrder).toEqual(['target-lazy-child', 'nested-lazy-child']);
  });

  it('renders real panel and section title shells without activating offscreen scene objects', async () => {
    const { container, dataSubscriptionSpy, gridItem, panel, queryRunner, row } = renderLazyDashboard();

    await waitFor(() => expect(container.querySelectorAll('[data-griditem-key]')).toHaveLength(2));

    expect(await screen.findByText('Persistent panel title')).toBeInTheDocument();
    expect(screen.getByText('Persistent section title')).toBeInTheDocument();
    expect(row.isActive).toBe(false);
    expect(gridItem.isActive).toBe(false);
    expect(panel.isActive).toBe(false);
    expect(queryRunner.isActive).toBe(false);
    expect(dataSubscriptionSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('loaded-panel-visualization')).not.toBeInTheDocument();
  });

  it('keeps collapsed section titles searchable without mounting their panels', async () => {
    const { container, gridItem, panel, queryRunner, row } = renderLazyDashboard(true);

    await waitFor(() => expect(container.querySelectorAll('[data-griditem-key]')).toHaveLength(1));

    expect(screen.getByText('Persistent section title')).toBeInTheDocument();
    expect(screen.queryByText('Persistent panel title')).not.toBeInTheDocument();
    expect(row.isActive).toBe(false);
    expect(gridItem.isActive).toBe(false);
    expect(panel.isActive).toBe(false);
    expect(queryRunner.isActive).toBe(false);
  });

  it('preserves title DOM nodes while activating the panel only at the existing lazy boundary', async () => {
    const { container, dataSubscriptionSpy, gridItem, panel, queryRunner, row } = renderLazyDashboard();

    const panelTitle = await screen.findByText('Persistent panel title');
    const sectionTitle = screen.getByText('Persistent section title');
    const sectionLoader = container.querySelector<HTMLElement>('[data-griditem-key="row-1"]');
    const gridItemLoader = container.querySelector<HTMLElement>('[data-griditem-key="grid-item-1"]');
    const panelLoader = getContainingLazyLoader(panelTitle);

    expect(sectionLoader).not.toBeNull();
    expect(gridItemLoader).not.toBeNull();
    expect(panelLoader).toBeInstanceOf(HTMLElement);

    enterViewport(sectionLoader!);
    enterViewport(gridItemLoader!);

    await waitFor(() => {
      expect(row.isActive).toBe(true);
      expect(gridItem.isActive).toBe(true);
    });
    expect(screen.getByText('Persistent section title')).toBe(sectionTitle);
    expect(screen.getByText('Persistent panel title')).toBe(panelTitle);
    expect(panel.isActive).toBe(false);
    expect(queryRunner.isActive).toBe(false);
    expect(dataSubscriptionSpy).not.toHaveBeenCalled();

    enterViewport(panelLoader!);

    await waitFor(() => {
      expect(panel.isActive).toBe(true);
      expect(queryRunner.isActive).toBe(true);
      expect(dataSubscriptionSpy).toHaveBeenCalled();
    });
    expect(screen.getByText('Persistent panel title')).toBe(panelTitle);
    expect(screen.queryByTestId('loaded-panel-visualization')).not.toBeInTheDocument();

    await act(async () => resolvePanelPlugin(panelPlugin));

    await waitFor(() => expect(screen.getByTestId('loaded-panel-visualization')).toBeInTheDocument());
    expect(screen.getByText('Persistent panel title')).toBe(panelTitle);
  });
});
