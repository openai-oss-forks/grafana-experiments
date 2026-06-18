import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(toolbars[0].parentElement).toHaveStyle({ flex: '1 1 0', minWidth: 0 });
    expect(toolbars[1].parentElement).toHaveStyle({ flex: '1 1 0', minWidth: 0 });
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

  test('keeps value columns visible in small indexed tables with long names', () => {
    const source = createItemSource(30);
    source.getItem.mockImplementation((index) => ({
      label: `series-${index}-${'long-name-'.repeat(20)}`,
      yAxis: 1,
    }));
    source.getDisplayValues = (index) => [
      { title: 'Min', text: String(index), numeric: index },
      { title: 'Max', text: String(index + 1), numeric: index + 1 },
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
    expect(table).toHaveStyle({ minWidth: '336px' });
    expect(getComputedStyle(table).tableLayout).toBe('fixed');
    expect(table.querySelector('col[span="2"]')).toHaveStyle({ width: '88px' });
    expect(screen.getByTitle('Min: Minimum value')).toBeInTheDocument();
    expect(screen.getByTitle('Max: Maximum value')).toBeInTheDocument();
  });

  test('keeps value columns visible in materialized tables with long names', () => {
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

    const table = screen.getByRole('table');
    expect(table).toHaveStyle({ minWidth: '336px' });
    expect(getComputedStyle(table).tableLayout).toBe('fixed');
    expect(table.querySelector('col[span="2"]')).toHaveStyle({ width: '88px' });
    expect(screen.getByTitle('Minimum value')).toHaveTextContent('Min');
    expect(screen.getByTitle('Maximum value')).toHaveTextContent('Max');
  });

  test('preserves auto table layout for custom materialized rows', () => {
    const items: VizLegendItem[] = [{ label: 'series-0', yAxis: 1 }];

    render(
      <VizLegendTable
        items={items}
        placement="right"
        itemRenderer={(_, index) => (
          <tr key={index}>
            <td>Name</td>
            <td>Custom value</td>
          </tr>
        )}
      />
    );

    const table = screen.getByRole('table');
    expect(getComputedStyle(table).tableLayout).not.toBe('fixed');
    expect(table.querySelector('colgroup')).not.toBeInTheDocument();
  });

  test('preserves auto table layout for custom indexed rows', () => {
    const source = createItemSource(30);

    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        itemRenderer={(_, index) => (
          <tr key={index}>
            <td>Name</td>
            <td>Custom value</td>
          </tr>
        )}
      />
    );

    const table = screen.getByRole('table');
    expect(getComputedStyle(table).tableLayout).not.toBe('fixed');
    expect(table.querySelector('colgroup')).not.toBeInTheDocument();
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
    const table = screen.getByRole('table');
    const hiddenHeader = table.querySelector('th')!;
    expect(table).toHaveAttribute('aria-rowcount', '1001');
    expect(hiddenHeader).toHaveClass('sr-only');
    expect(getComputedStyle(hiddenHeader).position).not.toBe('sticky');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-rowindex', '2');
  });

  test('keeps virtualized table rows in one opaque table layout while scrolling', () => {
    const longColumnTitle = 'Maximum statistical difference';
    const source = createItemSource(1_000);
    source.getDisplayValues = (index) => [
      { title: 'Last', text: String(index), numeric: index },
      { title: 'Mean', text: `${index}.123`, numeric: index + 0.123 },
      {
        title: longColumnTitle,
        text: `maximum-value-${index}-with-extra-precision`,
        numeric: index * 1_000_000,
      },
    ];

    render(
      <VizLegendTable
        items={[]}
        itemSource={source}
        placement="right"
        isSortable
        sortBy={longColumnTitle}
        displayValueColumns={[
          { title: 'Last', description: 'Last value' },
          { title: 'Mean', description: 'Mean value' },
          { title: longColumnTitle, description: 'Maximum value' },
        ]}
      />
    );

    const table = screen.getByRole('table');
    const scrollContainer = table.parentElement!;
    const firstHeaderCell = table.querySelector('th')!;
    const valueColumns = table.querySelector('col[span="3"]');
    expect(table).toHaveStyle({ minWidth: '424px' });
    expect(getComputedStyle(table).tableLayout).toBe('fixed');
    expect(valueColumns).toHaveStyle({ width: '88px' });
    expect(getComputedStyle(firstHeaderCell).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(firstHeaderCell).position).toBe('sticky');
    const sortedHeader = screen.getByTitle(`${longColumnTitle}: Maximum value`);
    const headerContent = sortedHeader.firstElementChild!;
    const headerLabel = headerContent.firstElementChild!;
    const sortIcon = headerContent.lastElementChild!;
    expect(headerContent).toHaveStyle({ display: 'flex' });
    expect(headerLabel).toHaveStyle({ overflow: 'hidden' });
    expect(sortIcon).toHaveStyle({ flexShrink: 0 });
    expect(screen.getByText('maximum-value-0-with-extra-precision')).toHaveAttribute(
      'title',
      'maximum-value-0-with-extra-precision'
    );
    expect(getComputedStyle(screen.getAllByRole('row')[1]).display).toBe('table-row');

    scrollContainer.scrollTop = 560;
    fireEvent.scroll(scrollContainer);

    const spacer = table.querySelector<HTMLTableRowElement>('tbody > tr[aria-hidden="true"]');
    expect(spacer).toHaveStyle({ height: '224px' });
    expect(spacer?.firstElementChild).toHaveAttribute('colspan', '4');
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('style');
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
