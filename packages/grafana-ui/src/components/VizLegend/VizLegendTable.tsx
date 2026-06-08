import { css, cx } from '@emotion/css';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type JSX, useMemo, useRef } from 'react';

import { GrafanaTheme2 } from '@grafana/data';

import { useStyles2 } from '../../themes/ThemeContext';
import { Icon } from '../Icon/Icon';

import { LegendTableItem } from './VizLegendTableItem';
import { VizLegendItem, VizLegendItemSource, VizLegendTableProps } from './types';

const nameSortKey = 'Name';
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const VIRTUALIZE_THRESHOLD = 200;
const VIRTUAL_ROW_HEIGHT = 28;

/**
 * @internal
 */
export const VizLegendTable = <T extends unknown>({
  items,
  itemSource,
  sortBy: sortKey,
  sortDesc,
  itemRenderer,
  className,
  onToggleSort,
  onLabelClick,
  onLabelMouseOver,
  onLabelMouseOut,
  readonly,
  isSortable,
  getItemDisplayValues,
  displayValueColumns,
}: VizLegendTableProps<T>): JSX.Element => {
  const styles = useStyles2(getStyles);

  if (itemSource) {
    return (
      <IndexedVizLegendTable
        className={className}
        displayValueColumns={displayValueColumns}
        getItemDisplayValues={getItemDisplayValues}
        isSortable={isSortable}
        itemRenderer={itemRenderer}
        itemSource={itemSource}
        onLabelClick={onLabelClick}
        onLabelMouseOut={onLabelMouseOut}
        onLabelMouseOver={onLabelMouseOver}
        onToggleSort={onToggleSort}
        readonly={readonly}
        sortDesc={sortDesc}
        sortKey={sortKey}
      />
    );
  }
  const getDisplayValues = (item: VizLegendItem<T>) => getItemDisplayValues?.(item) ?? item.getDisplayValues?.() ?? [];
  const header: Record<string, string> = {
    [nameSortKey]: '',
  };

  if (displayValueColumns) {
    for (const column of displayValueColumns) {
      header[column.title ?? '?'] = column.description ?? '';
    }
  } else {
    for (const item of items) {
      const displayValues = getDisplayValues(item);
      for (const displayValue of displayValues) {
        header[displayValue.title ?? '?'] = displayValue.description ?? '';
      }
    }
  }

  if (sortKey != null) {
    let itemVals = new Map<VizLegendItem, number>();

    items.forEach((item) => {
      if (sortKey !== nameSortKey) {
        const stat = getDisplayValues(item).find((stat) => stat.title === sortKey);
        const val = stat == null || Number.isNaN(stat.numeric) ? -Infinity : stat.numeric;
        itemVals.set(item, val);
      }
    });

    let sortMult = sortDesc ? -1 : 1;

    if (sortKey === nameSortKey) {
      // string sort
      items.sort((a, b) => {
        return sortMult * naturalCompare(a.label, b.label);
      });
    } else {
      // numeric sort
      items.sort((a, b) => {
        const aVal = itemVals.get(a) ?? 0;
        const bVal = itemVals.get(b) ?? 0;

        return sortMult * (aVal - bVal);
      });
    }
  }

  if (!itemRenderer) {
    if (items.length > VIRTUALIZE_THRESHOLD) {
      return (
        <VirtualizedVizLegendTable
          className={className}
          header={header}
          getItemDisplayValues={getDisplayValues}
          isSortable={isSortable}
          items={items}
          onLabelClick={onLabelClick}
          onLabelMouseOut={onLabelMouseOut}
          onLabelMouseOver={onLabelMouseOver}
          onToggleSort={onToggleSort}
          readonly={readonly}
          sortKey={sortKey}
          sortDesc={sortDesc}
        />
      );
    }

    /* eslint-disable-next-line react/display-name */
    itemRenderer = (item, index) => (
      <LegendTableItem
        key={`${item.label}-${index}`}
        item={item}
        onLabelClick={onLabelClick}
        onLabelMouseOver={onLabelMouseOver}
        onLabelMouseOut={onLabelMouseOut}
        readonly={readonly}
        displayValues={getDisplayValues(item)}
      />
    );
  }

  return (
    <table className={cx(styles.table, className)}>
      <thead>
        <tr>
          {Object.keys(header).map((columnTitle) => (
            <th
              title={header[columnTitle]}
              key={columnTitle}
              className={cx(styles.header, {
                [styles.headerSortable]: Boolean(onToggleSort),
                [styles.nameHeader]: isSortable,
                [styles.withIcon]: sortKey === columnTitle,
                'sr-only': !isSortable,
              })}
              onClick={() => {
                if (onToggleSort && isSortable) {
                  onToggleSort(columnTitle);
                }
              }}
            >
              {columnTitle}
              {sortKey === columnTitle && <Icon size="xs" name={sortDesc ? 'angle-down' : 'angle-up'} />}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{items.map(itemRenderer!)}</tbody>
    </table>
  );
};

function IndexedVizLegendTable<T>({
  className,
  displayValueColumns,
  getItemDisplayValues,
  isSortable,
  itemRenderer,
  itemSource,
  onLabelClick,
  onLabelMouseOut,
  onLabelMouseOver,
  onToggleSort,
  readonly,
  sortDesc,
  sortKey,
}: {
  className?: string;
  displayValueColumns?: VizLegendTableProps<T>['displayValueColumns'];
  getItemDisplayValues?: VizLegendTableProps<T>['getItemDisplayValues'];
  isSortable?: boolean;
  itemRenderer?: VizLegendTableProps<T>['itemRenderer'];
  itemSource: VizLegendItemSource<T>;
  onLabelClick?: VizLegendTableProps<T>['onLabelClick'];
  onLabelMouseOut?: VizLegendTableProps<T>['onLabelMouseOut'];
  onLabelMouseOver?: VizLegendTableProps<T>['onLabelMouseOver'];
  onToggleSort?: VizLegendTableProps<T>['onToggleSort'];
  readonly?: boolean;
  sortDesc?: boolean;
  sortKey?: string;
}) {
  const styles = useStyles2(getStyles);
  const header = useMemo(() => {
    const columns: Record<string, string> = { [nameSortKey]: '' };
    if (displayValueColumns) {
      for (const column of displayValueColumns) {
        columns[column.title ?? '?'] = column.description ?? '';
      }
    } else if (itemSource.length > 0) {
      for (const value of itemSource.getDisplayValues?.(0) ?? []) {
        columns[value.title ?? '?'] = value.description ?? '';
      }
    }
    return columns;
  }, [displayValueColumns, itemSource]);
  const sortedOrder = useMemo(() => {
    if (!sortKey || itemSource.length < 2) {
      return undefined;
    }
    if (!itemSource.getSortValue) {
      throw new Error('Sorted indexed legends require getSortValue');
    }
    const indexes = new Uint32Array(itemSource.length);
    for (let index = 0; index < indexes.length; index++) {
      indexes[index] = index;
    }
    const multiplier = sortDesc ? -1 : 1;
    if (sortKey === nameSortKey) {
      const labels = new Array<string>(indexes.length);
      for (let index = 0; index < indexes.length; index++) {
        const value = itemSource.getSortValue(index, sortKey);
        if (typeof value !== 'string') {
          throw new Error('Name-sorted indexed legends require string sort values');
        }
        labels[index] = value;
      }
      indexes.sort((left, right) => multiplier * naturalCompare(labels[left], labels[right]));
      return indexes;
    }
    const values = new Float64Array(indexes.length);
    for (let index = 0; index < indexes.length; index++) {
      const value = itemSource.getSortValue(index, sortKey);
      values[index] = typeof value === 'number' && !Number.isNaN(value) ? value : -Infinity;
    }
    indexes.sort((left, right) => {
      return multiplier * (values[left] - values[right]);
    });
    return indexes;
  }, [itemSource, sortDesc, sortKey]);
  const getDisplayValues = (sourceIndex: number, item: VizLegendItem<T>) =>
    itemSource.getDisplayValues?.(sourceIndex) ?? getItemDisplayValues?.(item) ?? item.getDisplayValues?.() ?? [];

  if (itemRenderer && itemSource.length > VIRTUALIZE_THRESHOLD) {
    throw new Error('Virtualized indexed legends do not support custom item renderers');
  }

  if (itemSource.length > VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualizedIndexedVizLegendTable
        className={className}
        getDisplayValues={getDisplayValues}
        header={header}
        isSortable={isSortable}
        itemSource={itemSource}
        onLabelClick={onLabelClick}
        onLabelMouseOut={onLabelMouseOut}
        onLabelMouseOver={onLabelMouseOver}
        onToggleSort={onToggleSort}
        sortedOrder={sortedOrder}
        readonly={readonly}
        sortDesc={sortDesc}
        sortKey={sortKey}
      />
    );
  }

  return (
    <table className={cx(styles.table, className)}>
      <LegendTableHeader
        header={header}
        isSortable={isSortable}
        onToggleSort={onToggleSort}
        sortDesc={sortDesc}
        sortKey={sortKey}
      />
      <tbody>
        {renderIndexedTableRows(itemSource, sortedOrder, itemRenderer, getDisplayValues, {
          onLabelClick,
          onLabelMouseOver,
          onLabelMouseOut,
          readonly,
        })}
      </tbody>
    </table>
  );
}

function renderIndexedTableRows<T>(
  itemSource: VizLegendItemSource<T>,
  sortedOrder: Uint32Array | undefined,
  itemRenderer: VizLegendTableProps<T>['itemRenderer'],
  getDisplayValues: (
    sourceIndex: number,
    item: VizLegendItem<T>
  ) => ReturnType<NonNullable<VizLegendTableProps<T>['getItemDisplayValues']>>,
  options: Pick<VizLegendTableProps<T>, 'onLabelClick' | 'onLabelMouseOut' | 'onLabelMouseOver' | 'readonly'>
) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < itemSource.length; rowIndex++) {
    const sourceIndex = sortedOrder?.[rowIndex] ?? rowIndex;
    const item = itemSource.getItem(sourceIndex);
    rows.push(
      itemRenderer ? (
        itemRenderer(item, rowIndex)
      ) : (
        <LegendTableItem
          key={itemSource.getItemKey(sourceIndex)}
          item={item}
          onLabelClick={options.onLabelClick}
          onLabelMouseOver={options.onLabelMouseOver}
          onLabelMouseOut={options.onLabelMouseOut}
          readonly={options.readonly}
          displayValues={getDisplayValues(sourceIndex, item)}
        />
      )
    );
  }
  return rows;
}

function LegendTableHeader({
  gridTemplateColumns,
  header,
  isSortable,
  onToggleSort,
  sortDesc,
  sortKey,
  virtual = false,
}: {
  gridTemplateColumns?: string;
  header: Record<string, string>;
  isSortable?: boolean;
  onToggleSort?: (sortBy: string) => void;
  sortDesc?: boolean;
  sortKey?: string;
  virtual?: boolean;
}) {
  const styles = useStyles2(getStyles);
  return (
    <thead className={virtual ? styles.virtualHeader : undefined}>
      <tr style={gridTemplateColumns ? { gridTemplateColumns } : undefined}>
        {Object.keys(header).map((columnTitle) => (
          <th
            title={header[columnTitle]}
            key={columnTitle}
            className={cx(styles.header, {
              [styles.headerSortable]: Boolean(onToggleSort),
              [styles.nameHeader]: isSortable,
              [styles.withIcon]: sortKey === columnTitle,
              'sr-only': !isSortable,
            })}
            onClick={() => onToggleSort && isSortable && onToggleSort(columnTitle)}
          >
            {columnTitle}
            {sortKey === columnTitle && <Icon size="xs" name={sortDesc ? 'angle-down' : 'angle-up'} />}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function VirtualizedIndexedVizLegendTable<T>({
  className,
  getDisplayValues,
  header,
  isSortable,
  itemSource,
  onLabelClick,
  onLabelMouseOut,
  onLabelMouseOver,
  onToggleSort,
  sortedOrder,
  readonly,
  sortDesc,
  sortKey,
}: {
  className?: string;
  getDisplayValues: (
    sourceIndex: number,
    item: VizLegendItem<T>
  ) => ReturnType<NonNullable<VizLegendTableProps<T>['getItemDisplayValues']>>;
  header: Record<string, string>;
  isSortable?: boolean;
  itemSource: VizLegendItemSource<T>;
  onLabelClick?: VizLegendTableProps<T>['onLabelClick'];
  onLabelMouseOut?: VizLegendTableProps<T>['onLabelMouseOut'];
  onLabelMouseOver?: VizLegendTableProps<T>['onLabelMouseOver'];
  onToggleSort?: VizLegendTableProps<T>['onToggleSort'];
  sortedOrder?: Uint32Array;
  readonly?: boolean;
  sortDesc?: boolean;
  sortKey?: string;
}) {
  const styles = useStyles2(getStyles);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: itemSource.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    getItemKey: (index) => itemSource.getItemKey(sortedOrder?.[index] ?? index),
    overscan: 12,
  });
  const gridTemplateColumns = `minmax(0, 1fr) repeat(${Math.max(Object.keys(header).length - 1, 0)}, max-content)`;

  return (
    <div ref={scrollRef} className={cx(styles.virtualScroll, className)}>
      <table className={cx(styles.table, styles.virtualTable)} aria-rowcount={itemSource.length + 1}>
        <LegendTableHeader
          gridTemplateColumns={gridTemplateColumns}
          header={header}
          isSortable={isSortable}
          onToggleSort={onToggleSort}
          sortDesc={sortDesc}
          sortKey={sortKey}
          virtual
        />
        <tbody className={styles.virtualBody} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const sourceIndex = sortedOrder?.[row.index] ?? row.index;
            const item = itemSource.getItem(sourceIndex);
            return (
              <LegendTableItem
                key={row.key}
                item={item}
                onLabelClick={onLabelClick}
                onLabelMouseOver={onLabelMouseOver}
                onLabelMouseOut={onLabelMouseOut}
                readonly={readonly}
                displayValues={getDisplayValues(sourceIndex, item)}
                className={styles.virtualRow}
                rowIndex={row.index + 2}
                style={{ gridTemplateColumns, transform: `translateY(${row.start}px)` }}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VirtualizedVizLegendTable<T>({
  className,
  header,
  getItemDisplayValues,
  isSortable,
  items,
  onLabelClick,
  onLabelMouseOut,
  onLabelMouseOver,
  onToggleSort,
  readonly,
  sortKey,
  sortDesc,
}: {
  className?: string;
  header: Record<string, string>;
  getItemDisplayValues: (
    item: VizLegendItem<T>
  ) => ReturnType<NonNullable<VizLegendTableProps<T>['getItemDisplayValues']>>;
  isSortable?: boolean;
  items: Array<VizLegendItem<T>>;
  onLabelClick?: VizLegendTableProps<T>['onLabelClick'];
  onLabelMouseOut?: VizLegendTableProps<T>['onLabelMouseOut'];
  onLabelMouseOver?: VizLegendTableProps<T>['onLabelMouseOver'];
  onToggleSort?: VizLegendTableProps<T>['onToggleSort'];
  readonly?: boolean;
  sortKey?: string;
  sortDesc?: boolean;
}) {
  const styles = useStyles2(getStyles);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    overscan: 12,
  });
  const gridTemplateColumns = `minmax(0, 1fr) repeat(${Math.max(Object.keys(header).length - 1, 0)}, max-content)`;

  return (
    <div ref={scrollRef} className={cx(styles.virtualScroll, className)}>
      <table className={cx(styles.table, styles.virtualTable)} aria-rowcount={items.length}>
        <thead className={styles.virtualHeader}>
          <tr style={{ gridTemplateColumns }}>
            {Object.keys(header).map((columnTitle) => (
              <th
                title={header[columnTitle]}
                key={columnTitle}
                className={cx(styles.header, {
                  [styles.headerSortable]: Boolean(onToggleSort),
                  [styles.nameHeader]: isSortable,
                  [styles.withIcon]: sortKey === columnTitle,
                  'sr-only': !isSortable,
                })}
                onClick={() => {
                  if (onToggleSort && isSortable) {
                    onToggleSort(columnTitle);
                  }
                }}
              >
                {columnTitle}
                {sortKey === columnTitle && <Icon size="xs" name={sortDesc ? 'angle-down' : 'angle-up'} />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={styles.virtualBody} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => (
            <LegendTableItem
              key={row.key}
              item={items[row.index]}
              onLabelClick={onLabelClick}
              onLabelMouseOver={onLabelMouseOver}
              onLabelMouseOut={onLabelMouseOut}
              readonly={readonly}
              displayValues={getItemDisplayValues(items[row.index])}
              className={styles.virtualRow}
              style={{ gridTemplateColumns, transform: `translateY(${row.start}px)` }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  table: css({
    width: '100%',
    'th:first-child': {
      width: '100%',
      borderBottom: `1px solid ${theme.colors.border.weak}`,
    },
  }),
  header: css({
    color: theme.colors.primary.text,
    fontWeight: theme.typography.fontWeightMedium,
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    padding: theme.spacing(0.25, 1, 0.25, 1),
    fontSize: theme.typography.bodySmall.fontSize,
    textAlign: 'right',
    whiteSpace: 'nowrap',
  }),
  nameHeader: css({
    textAlign: 'left',
    paddingLeft: '30px',
  }),
  // This needs to be padding-right - icon size(xs==12) to avoid jumping
  withIcon: css({
    paddingRight: '4px',
  }),
  headerSortable: css({
    cursor: 'pointer',
  }),
  virtualScroll: css({
    height: '100%',
    minHeight: VIRTUAL_ROW_HEIGHT * 3,
    overflow: 'auto',
    width: '100%',
  }),
  virtualTable: css({
    display: 'block',
  }),
  virtualHeader: css({
    display: 'block',
    position: 'sticky',
    top: 0,
    zIndex: 1,
    tr: {
      display: 'grid',
    },
  }),
  virtualBody: css({
    display: 'block',
    position: 'relative',
    width: '100%',
  }),
  virtualRow: css({
    display: 'grid',
    left: 0,
    minHeight: VIRTUAL_ROW_HEIGHT,
    position: 'absolute',
    top: 0,
    width: '100%',
  }),
});
