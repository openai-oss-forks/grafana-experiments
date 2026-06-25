import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    expect(toolbars[0].parentElement).toHaveStyle({ flex: '1 1 0', maxWidth: '100%', minWidth: 0 });
    expect(toolbars[1].parentElement).toHaveStyle({ flex: '1 1 0', maxWidth: '100%', minWidth: 0 });
    expect(source.getItem).toHaveBeenCalled();
    expect(source.getItem.mock.calls.length).toBeLessThan(50);
    expect(source.getItem.mock.calls[0][0]).toBe(0);
  });

  test('keeps materialized bottom indexed legends bounded so long labels can wrap', () => {
    const source = createItemSource(40);
    source.getItem.mockImplementation((index) => ({
      label: `series-${index}-${'x'.repeat(200)}`,
      yAxis: index % 2 === 0 ? 1 : 2,
    }));

    render(<VizLegendList items={[]} itemSource={source} placement="bottom" />);

    for (const [index, name] of [source.getItem(0).label, source.getItem(1).label].entries()) {
      const button = screen.getByRole('button', { name });
      const item = button.closest('li');
      const list = item?.closest('ul');
      expect(button).toHaveStyle({ overflowWrap: 'anywhere', whiteSpace: 'normal' });
      expect(item).toHaveStyle({ display: 'inline-block', maxWidth: '100%', verticalAlign: 'top' });
      expect(list).toHaveStyle({ maxWidth: '100%', minWidth: 0, width: 'fit-content' });
      if (index === 1) {
        expect(list).toHaveStyle({ textAlign: 'right' });
        expect(list?.parentElement).toHaveStyle({ flexBasis: 0, justifyContent: 'flex-end' });
      }
      expect(list?.parentElement).toHaveStyle({ flex: '1 1 0', maxWidth: '100%', minWidth: 0 });
    }
  });

  test('keeps materialized bottom legends bounded so long labels can wrap', () => {
    const items: VizLegendItem[] = [
      { label: `left-${'x'.repeat(200)}`, yAxis: 1 },
      { label: `right-${'x'.repeat(200)}`, yAxis: 2 },
    ];

    render(<VizLegendList items={items} placement="bottom" />);

    for (const [index, item] of items.entries()) {
      const button = screen.getByRole('button', { name: item.label });
      const list = button.closest('ul');
      expect(button).toHaveStyle({ overflowWrap: 'anywhere', whiteSpace: 'normal' });
      expect(list).toHaveStyle({ maxWidth: '100%', minWidth: 0, width: 'fit-content' });
      expect(list?.parentElement).toHaveStyle({ flex: '1 1 0', maxWidth: '100%', minWidth: 0 });
      if (index === 1) {
        expect(list).toHaveStyle({ textAlign: 'right' });
        expect(list?.parentElement).toHaveStyle({ flexBasis: 0, justifyContent: 'flex-end' });
      }
    }
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

  test('aligns materialized Name and value headers', () => {
    const items: VizLegendItem[] = [
      {
        label: `series-${'long-name-'.repeat(20)}`,
        yAxis: 1,
        getDisplayValues: () => [
          { title: 'Min', description: 'Minimum value', text: '1', numeric: 1 },
          { title: 'Max', description: 'Maximum value', text: '2', numeric: 2 },
        ],
      },
    ];

    render(<VizLegendTable items={items} placement="right" isSortable />);

    const [nameHeader, minHeader, maxHeader] = screen.getAllByRole('columnheader');
    expect(nameHeader).toHaveStyle({ textAlign: 'left' });
    expect(minHeader).toHaveStyle({ textAlign: 'right' });
    expect(maxHeader).toHaveStyle({ textAlign: 'right' });
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

  test('keeps virtualized names and Min/Max values aligned while scrolling', async () => {
    const source = createItemSource(1_000);
    source.getDisplayValues = (index) => [
      { title: 'Min', text: `min-${index}`, numeric: index },
      { title: 'Max', text: `max-${index}`, numeric: index },
    ];

    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        isSortable
        displayValueColumns={[
          { title: 'Min', description: 'Minimum value' },
          { title: 'Max', description: 'Maximum value' },
        ]}
      />
    );

    const table = screen.getByRole('table');
    const scrollContainer = table.parentElement!;
    expect(getComputedStyle(table).tableLayout).toBe('fixed');
    expect(table.querySelector('col[span="2"]')).toHaveStyle({ width: '88px' });
    const [nameHeader, minHeader, maxHeader] = screen.getAllByRole('columnheader');
    expect(getComputedStyle(nameHeader).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(nameHeader).position).toBe('sticky');
    expect(nameHeader).toHaveStyle({ textAlign: 'left', width: 'auto' });
    expect(minHeader).toHaveStyle({ textAlign: 'right' });
    expect(maxHeader).toHaveStyle({ textAlign: 'right' });

    scrollContainer.scrollTop = 560;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'series-0' })).not.toBeInTheDocument());
    const label = screen.getAllByRole('button')[0];
    const index = label.textContent?.replace('series-', '').trim();
    const cells = within(label.closest('tr')!).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent(`series-${index}`);
    expect(cells[1]).toHaveTextContent(`min-${index}`);
    expect(cells[1]).toHaveAttribute('title', `min-${index}`);
    expect(cells[2]).toHaveTextContent(`max-${index}`);
    expect(getComputedStyle(label.closest('tr')!).display).toBe('table-row');
  });

  test('keeps non-virtual indexed value columns readable in narrow legends', () => {
    const source = createItemSource(1);
    source.getDisplayValues = () => [
      { title: 'Mean', text: '1', numeric: 1 },
      { title: 'Min', text: '1', numeric: 1 },
      { title: 'Max', text: '1', numeric: 1 },
      { title: 'Last', text: '1', numeric: 1 },
      { title: 'Total', text: '1', numeric: 1 },
    ];

    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        isSortable
        displayValueColumns={source.getDisplayValues(0)}
      />
    );

    const table = screen.getByRole('table');
    expect(getComputedStyle(table).tableLayout).toBe('fixed');
    expect(table).toHaveStyle({ minWidth: '600px' });
    expect(table.querySelector('col[span="5"]')).toHaveStyle({ width: '88px' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveStyle({ width: 'auto' });
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
    const user = userEvent.setup();
    const source = createItemSource(1_000);
    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        displayValueColumns={[{ title: 'Last', description: 'Last value' }]}
      />
    );
    screen.getByRole('button', { name: 'series-0' }).focus();
    await user.keyboard('{End}');

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
