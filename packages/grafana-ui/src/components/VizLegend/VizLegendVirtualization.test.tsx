import { render, screen } from '@testing-library/react';
import type { Key } from 'react';

import { LegendDisplayMode } from '@grafana/schema';

import { VizTooltipContent } from '../VizTooltip/VizTooltipContent';

import { VizLegend } from './VizLegend';
import { VizLegendList } from './VizLegendList';
import { VizLegendTable } from './VizLegendTable';
import { VizLegendItem, VizLegendItemSource } from './types';

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => Key }) => {
    const virtualItems: Array<{ index: number; key: Key; start: number }> = [];
    for (let index = 0; index < Math.min(count, 5); index++) {
      virtualItems.push({ index, key: getItemKey?.(index) ?? index, start: index * 28 });
    }
    return {
      getTotalSize: () => count * 28,
      getVirtualItems: () => virtualItems,
      measureElement: () => undefined,
      scrollToIndex: () => undefined,
    };
  },
}));

describe('high-cardinality visualization UI', () => {
  test('bounds the number of rendered legend rows', () => {
    const items: VizLegendItem[] = Array.from({ length: 1_000 }, (_, index) => ({
      label: `series-${index}`,
      yAxis: 1,
    }));

    render(<VizLegendList items={items} placement="right" />);

    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(screen.queryAllByRole('button').length).toBeLessThan(items.length);
  });

  test('bounds the number of rendered multi-tooltip rows', () => {
    const items = Array.from({ length: 1_000 }, (_, index) => ({
      label: `series-${index}`,
      value: String(index),
    }));

    render(<VizTooltipContent items={items} isPinned={false} />);

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem').length).toBeLessThan(items.length);
  });

  test('bounds the number of rendered table legend rows', () => {
    const items: VizLegendItem[] = Array.from({ length: 1_000 }, (_, index) => ({
      label: `series-${index}`,
      yAxis: 1,
    }));

    render(<VizLegendTable items={items} placement="right" />);

    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('row').length).toBeLessThan(items.length);
  });

  test('does not reduce every series to discover known table columns', () => {
    const items: VizLegendItem[] = Array.from({ length: 1_000 }, (_, index) => ({
      label: `series-${index}`,
      yAxis: 1,
    }));
    const getItemDisplayValues = jest.fn(() => [{ title: 'Last', text: '1', numeric: 1 }]);

    render(
      <VizLegendTable
        items={items}
        placement="right"
        getItemDisplayValues={getItemDisplayValues}
        displayValueColumns={[{ title: 'Last', description: 'Last value' }]}
      />
    );

    expect(getItemDisplayValues.mock.calls.length).toBeLessThan(items.length);
  });

  test('materializes only rendered rows from an indexed legend source', () => {
    const source = createItemSource(100_000);

    render(<VizLegendList items={[]} itemSource={source} placement="right" />);

    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(source.getItem).toHaveBeenCalledTimes(5);
  });

  test('keeps bottom indexed legends bounded', () => {
    const source = createItemSource(100_000);

    render(<VizLegendList items={[]} itemSource={source} placement="bottom" />);

    const toolbars = screen.getAllByRole('toolbar');
    expect(toolbars).toHaveLength(2);
    expect(toolbars[0]).toHaveAttribute('aria-orientation', 'horizontal');
    expect(source.getItem).toHaveBeenCalledTimes(10);
    expect(source.getItem.mock.calls.map(([index]) => index)).toEqual([0, 2, 4, 6, 8, 1, 3, 5, 7, 9]);
  });

  test('sorts indexed tables without materializing offscreen items', () => {
    const source = createItemSource(1_000);

    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        sortBy="Last"
        sortDesc
        displayValueColumns={[{ title: 'Last', description: 'Last value' }]}
      />
    );

    expect(source.getSortValue).toHaveBeenCalledTimes(source.length);
    expect(source.getItem).toHaveBeenCalledTimes(5);
    expect(source.getItem).toHaveBeenNthCalledWith(1, 999);
  });

  test('does not build a sort order for unsorted indexed tables', () => {
    const source = createItemSource(1_000);

    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        displayValueColumns={[{ title: 'Last', description: 'Last value' }]}
      />
    );

    expect(source.getSortValue).not.toHaveBeenCalled();
    expect(source.getItem).toHaveBeenCalledTimes(5);
    expect(source.getItem).toHaveBeenNthCalledWith(1, 0);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '1001');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-rowindex', '2');
  });

  test('does not apply the primary indexed source to threshold legends', () => {
    const source = createItemSource(1_000);

    render(
      <VizLegend
        items={[]}
        itemSource={source}
        thresholdItems={[
          { label: 'low', yAxis: 1 },
          { label: 'high', yAxis: 1 },
        ]}
        displayMode={LegendDisplayMode.List}
        placement="right"
      />
    );

    expect(screen.getByText('low')).toBeInTheDocument();
    expect(source.getItem).not.toHaveBeenCalled();
  });
});

function createItemSource(length: number) {
  const getItem = jest.fn(
    (index: number): VizLegendItem => ({ label: `series-${index}`, yAxis: index % 2 === 0 ? 1 : 2 })
  );
  const getDisplayValues = (index: number) => [{ title: 'Last', text: String(index), numeric: index }];
  const getSortValue = jest.fn((index: number, sortBy: string) => (sortBy === 'Name' ? `series-${index}` : index));
  const source = {
    length,
    getItem,
    getItemKey: (index: number) => index,
    getItemsForYAxis: (yAxis: 1 | 2): VizLegendItemSource => {
      const offset = yAxis - 1;
      const axisLength = Math.floor((length + (yAxis === 1 ? 1 : 0)) / 2);
      const toSourceIndex = (index: number) => index * 2 + offset;
      return {
        length: axisLength,
        getItem: (index) => getItem(toSourceIndex(index)),
        getItemKey: (index) => toSourceIndex(index),
        getDisplayValues: (index) => getDisplayValues(toSourceIndex(index)),
        getSortValue: (index, sortBy) => getSortValue(toSourceIndex(index), sortBy),
      };
    },
    getDisplayValues,
    getSortValue,
  } satisfies VizLegendItemSource;
  return source;
}
