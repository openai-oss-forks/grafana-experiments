import { render, screen, waitFor } from '@testing-library/react';

import { LazyLoader, SceneGridLayout, SceneGridRow, SceneQueryRunner, VizPanel } from '@grafana/scenes';

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
});
