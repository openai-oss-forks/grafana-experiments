import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LegendDisplayMode } from '@grafana/schema';

import { VizLegend } from './VizLegend';
import { VizLegendList } from './VizLegendList';
import { VizLegendTable } from './VizLegendTable';
import { VizLegendItem, VizLegendItemSource } from './types';

describe('high-cardinality visualization UI', () => {
  test('materializes only rendered rows from an indexed legend source', () => {
    const source = createItemSource(100_000);

    render(<VizLegendList items={[]} itemSource={source} placement="right" />);

    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(source.getItem).toHaveBeenCalled();
    expect(source.getItem.mock.calls.length).toBeLessThan(40);
  });

  test('keeps bottom indexed legends bounded', () => {
    const source = createItemSource(100_000);

    render(<VizLegendList items={[]} itemSource={source} placement="bottom" />);

    const toolbars = screen.getAllByRole('toolbar');
    expect(toolbars).toHaveLength(2);
    expect(toolbars[0]).toHaveAttribute('aria-orientation', 'horizontal');
    expect(source.getItem).toHaveBeenCalled();
    expect(source.getItem.mock.calls.length).toBeLessThan(50);
    expect(source.getItem.mock.calls[0][0]).toBe(0);
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
    expect(source.getItem).toHaveBeenCalled();
    expect(source.getItem.mock.calls.length).toBeLessThan(40);
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
    expect(source.getItem).toHaveBeenCalled();
    expect(source.getItem.mock.calls.length).toBeLessThan(40);
    expect(source.getItem).toHaveBeenNthCalledWith(1, 0);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '1001');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-rowindex', '2');
  });

  test('recovers the visible window when an indexed source shrinks', () => {
    const largeSource = createItemSource(1_000);
    const { rerender } = render(<VizLegendList items={[]} itemSource={largeSource} placement="right" />);
    const toolbar = screen.getByRole('toolbar');

    toolbar.scrollTop = 20_000;
    fireEvent.scroll(toolbar);
    rerender(<VizLegendList items={[]} itemSource={createItemSource(10)} placement="right" />);

    expect(screen.getByText('series-0')).toBeInTheDocument();
  });

  test('supports keyboard navigation to offscreen indexed table rows', async () => {
    const source = createItemSource(1_000);
    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        displayValueColumns={[{ title: 'Last', description: 'Last value' }]}
      />
    );
    const scrollContainer = screen.getByRole('table').parentElement!;

    scrollContainer.focus();
    fireEvent.keyDown(scrollContainer, { key: 'End' });

    await waitFor(() => expect(document.activeElement).toHaveTextContent('series-999'));
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
