import { act, render, screen, waitFor } from '@testing-library/react';

import { LazyLoader, SceneGridLayout, SceneGridRow, SceneQueryRunner, VizPanel } from '@grafana/scenes';

import { DashboardPanelTitlePlaceholder } from '../layouts-shared/DashboardPanelTitlePlaceholder';

import { DashboardGridItem } from './DashboardGridItem';

jest.mock('react-use', () => ({
  ...jest.requireActual('react-use'),
  useMeasure: () => [jest.fn(), { width: 1200, height: 800 }],
}));

describe('default grid browser search placeholders', () => {
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

  it('renders panel and section titles without activating offscreen scene objects', async () => {
    const queryRunner = new SceneQueryRunner({ queries: [{ refId: 'A' }] });
    const panel = new VizPanel({ key: 'panel-1', title: 'Offscreen panel title', $data: queryRunner });
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
      title: 'Offscreen section title',
      children: [gridItem],
    });
    const grid = new SceneGridLayout({ isLazy: true, children: [row] });
    const GridComponent = grid.Component;

    const { container } = render(<GridComponent model={grid} />);

    await waitFor(() => expect(container.querySelectorAll('[data-griditem-key]')).toHaveLength(2));

    expect(screen.getByText('Offscreen panel title')).toBeInTheDocument();
    expect(screen.getByText('Offscreen section title')).toBeInTheDocument();
    expect(row.isActive).toBe(false);
    expect(gridItem.isActive).toBe(false);
    expect(panel.isActive).toBe(false);
    expect(queryRunner.isActive).toBe(false);
  });

  it('keeps the searchable section title mounted when the row loads', async () => {
    const row = new SceneGridRow({ key: 'row-1', title: 'Persistent section title', children: [], y: 0 });
    const grid = new SceneGridLayout({ isLazy: true, children: [row] });
    const GridComponent = grid.Component;
    const { container } = render(<GridComponent model={grid} />);

    await waitFor(() => expect(container.querySelector('[data-griditem-key="row-1"]')).toBeInTheDocument());

    const title = screen.getByText('Persistent section title');
    const sectionShell = container.querySelector<HTMLElement>('[data-griditem-key="row-1"]');
    expect(sectionShell).not.toBeNull();

    enterViewport(sectionShell!);

    await waitFor(() => expect(row.isActive).toBe(true));

    const renderedTitle = sectionShell!.querySelector<HTMLElement>('button[data-testid] [role="heading"]');
    expect(title).toBeInTheDocument();
    expect(renderedTitle).not.toBeNull();
    expect(getComputedStyle(renderedTitle!).visibility).toBe('hidden');
  });

  it('keeps only the persistent panel title visible after loading', async () => {
    const panel = new VizPanel({ title: 'Persistent panel title' });
    const { container } = render(
      <LazyLoader key="panel-1" placeholder={<DashboardPanelTitlePlaceholder panel={panel} />}>
        <div data-testid="loaded-panel-content">
          <div data-viz-panel-key="panel-1">
            <div data-testid="data-testid header-container">
              <h2>Persistent panel title</h2>
            </div>
            <DashboardPanelTitlePlaceholder panel={panel} />
          </div>
        </div>
      </LazyLoader>
    );

    const persistentTitle = screen.getByText('Persistent panel title');
    const lazyLoader = container.firstElementChild;
    expect(lazyLoader).toBeInstanceOf(HTMLElement);

    enterViewport(lazyLoader as HTMLElement);

    await waitFor(() => expect(screen.getByTestId('loaded-panel-content')).toBeInTheDocument());

    const renderedTitle = container.querySelector<HTMLElement>(
      '[data-viz-panel-key] [data-testid="data-testid header-container"] h2'
    );
    const nestedPlaceholder = container.querySelector<HTMLElement>(
      '[data-viz-panel-key] [data-dashboard-panel-title-placeholder]'
    );

    expect(persistentTitle).toBeInTheDocument();
    expect(renderedTitle).not.toBeNull();
    expect(nestedPlaceholder).not.toBeNull();
    expect(getComputedStyle(renderedTitle!).visibility).toBe('hidden');
    expect(getComputedStyle(nestedPlaceholder!).visibility).toBe('hidden');
  });
});
