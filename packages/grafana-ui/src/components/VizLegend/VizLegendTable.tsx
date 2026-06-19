import { css, cx } from '@emotion/css';
import { type JSX, useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { GrafanaTheme2 } from '@grafana/data';

import { useStyles2 } from '../../themes/ThemeContext';
import { Icon } from '../Icon/Icon';
import { useFixedVirtualWindow } from '../Virtualization/useFixedVirtualWindow';

import { LegendTableItem } from './VizLegendTableItem';
import { VizLegendItem, VizLegendItemSource, VizLegendTableProps } from './types';

const nameSortKey = 'Name';
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const VIRTUALIZE_THRESHOLD = 200;
const VIRTUAL_ROW_HEIGHT = 28;
const VIRTUAL_OVERSCAN = 12;
const TABLE_NAME_COLUMN_MIN_WIDTH = 160;
const TABLE_VALUE_COLUMN_WIDTH = 88;

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
  const header: Record<string, string> = {
    [nameSortKey]: '',
  };

  for (const item of items) {
    if (item.getDisplayValues) {
      for (const displayValue of item.getDisplayValues()) {
        header[displayValue.title ?? '?'] = displayValue.description ?? '';
      }
    }
  }

  if (sortKey != null) {
    let itemVals = new Map<VizLegendItem, number>();

    items.forEach((item) => {
      if (sortKey !== nameSortKey && item.getDisplayValues) {
        const stat = item.getDisplayValues().find((stat) => stat.title === sortKey);
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

  const hasCustomItemRenderer = Boolean(itemRenderer);
  if (!itemRenderer) {
    /* eslint-disable-next-line react/display-name */
    itemRenderer = (item, index) => (
      <LegendTableItem
        key={`${item.label}-${index}`}
        item={item}
        onLabelClick={onLabelClick}
        onLabelMouseOver={onLabelMouseOver}
        onLabelMouseOut={onLabelMouseOut}
        readonly={readonly}
      />
    );
  }

  const valueColumnCount = Math.max(0, Object.keys(header).length - 1);

  return (
    <table
      className={cx(styles.table, !hasCustomItemRenderer && styles.fixedTable, className)}
      style={
        hasCustomItemRenderer
          ? undefined
          : { minWidth: TABLE_NAME_COLUMN_MIN_WIDTH + valueColumnCount * TABLE_VALUE_COLUMN_WIDTH }
      }
    >
      {!hasCustomItemRenderer && <LegendTableColGroup valueColumnCount={valueColumnCount} />}
      <thead>
        <tr>
          {Object.keys(header).map((columnTitle) => (
            <th
              title={header[columnTitle]}
              key={columnTitle}
              className={cx(styles.header, {
                [styles.headerSortable]: Boolean(onToggleSort),
                [styles.nameHeader]: isSortable && columnTitle === nameSortKey,
                [styles.withIcon]: sortKey === columnTitle,
                'sr-only': !isSortable,
              })}
              onClick={() => {
                if (onToggleSort && isSortable) {
                  onToggleSort(columnTitle);
                }
              }}
            >
              <LegendTableHeaderContent columnTitle={columnTitle} sortDesc={sortDesc} sortKey={sortKey} />
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

  const valueColumnCount = Math.max(0, Object.keys(header).length - 1);

  return (
    <table
      className={cx(styles.table, !itemRenderer && styles.fixedTable, className)}
      style={
        itemRenderer
          ? undefined
          : { minWidth: TABLE_NAME_COLUMN_MIN_WIDTH + valueColumnCount * TABLE_VALUE_COLUMN_WIDTH }
      }
    >
      {!itemRenderer && <LegendTableColGroup valueColumnCount={valueColumnCount} />}
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

function LegendTableHeaderContent({
  columnTitle,
  sortDesc,
  sortKey,
}: {
  columnTitle: string;
  sortDesc?: boolean;
  sortKey?: string;
}) {
  const styles = useStyles2(getStyles);
  return (
    <span
      className={cx(styles.headerContent, {
        [styles.valueHeaderContent]: columnTitle !== nameSortKey,
      })}
    >
      <span className={styles.headerLabel}>{columnTitle}</span>
      {sortKey === columnTitle && (
        <span className={styles.headerSortIcon}>
          <Icon size="xs" name={sortDesc ? 'angle-down' : 'angle-up'} />
        </span>
      )}
    </span>
  );
}

function LegendTableHeader({
  header,
  isSortable,
  onToggleSort,
  sortDesc,
  sortKey,
  virtual = false,
}: {
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
      <tr>
        {Object.keys(header).map((columnTitle) => (
          <th
            title={header[columnTitle] ? `${columnTitle}: ${header[columnTitle]}` : columnTitle}
            key={columnTitle}
            className={cx(styles.header, {
              [styles.headerSortable]: Boolean(onToggleSort),
              [styles.nameHeader]: isSortable && columnTitle === nameSortKey,
              [styles.withIcon]: sortKey === columnTitle,
              'sr-only': !isSortable,
            })}
            onClick={() => onToggleSort && isSortable && onToggleSort(columnTitle)}
          >
            <LegendTableHeaderContent columnTitle={columnTitle} sortDesc={sortDesc} sortKey={sortKey} />
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
  const { scrollToIndex, totalSize, virtualItems } = useFixedVirtualWindow({
    containerRef: scrollRef,
    count: itemSource.length,
    itemSize: VIRTUAL_ROW_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
    initialViewportSize: VIRTUAL_ROW_HEIGHT * 12,
  });
  const columnCount = Object.keys(header).length;
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const topSpacerSize = firstVirtualItem?.start ?? 0;
  const bottomSpacerSize = lastVirtualItem
    ? Math.max(0, totalSize - lastVirtualItem.start - VIRTUAL_ROW_HEIGHT)
    : totalSize;
  const valueColumnCount = Math.max(0, columnCount - 1);
  const focusItem = useCallback(
    (index: number) => {
      const nextIndex = Math.max(0, Math.min(itemSource.length - 1, index));
      scrollToIndex(nextIndex);
      window.requestAnimationFrame(() => {
        scrollRef.current?.querySelector<HTMLButtonElement>(`tr[aria-rowindex="${nextIndex + 2}"] button`)?.focus();
      });
    },
    [itemSource.length, scrollToIndex]
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const focusedRow = document.activeElement?.closest('tr[aria-rowindex]');
      const currentIndex =
        focusedRow instanceof HTMLTableRowElement ? Number(focusedRow.getAttribute('aria-rowindex')) - 2 : -1;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusItem(currentIndex + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusItem(currentIndex - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusItem(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusItem(itemSource.length - 1);
      }
    },
    [focusItem, itemSource.length]
  );
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div ref={scrollRef} className={cx(styles.virtualScroll, className)}>
      <table
        className={cx(styles.table, styles.fixedTable)}
        aria-rowcount={itemSource.length + 1}
        style={{ minWidth: TABLE_NAME_COLUMN_MIN_WIDTH + valueColumnCount * TABLE_VALUE_COLUMN_WIDTH }}
      >
        <LegendTableColGroup valueColumnCount={valueColumnCount} />
        <LegendTableHeader
          header={header}
          isSortable={isSortable}
          onToggleSort={onToggleSort}
          sortDesc={sortDesc}
          sortKey={sortKey}
          virtual
        />
        <tbody>
          <VirtualTableSpacer columnCount={columnCount} size={topSpacerSize} />
          {virtualItems.map((row) => {
            const sourceIndex = sortedOrder?.[row.index] ?? row.index;
            const item = itemSource.getItem(sourceIndex);
            return (
              <LegendTableItem
                key={itemSource.getItemKey(sourceIndex)}
                item={item}
                onLabelClick={onLabelClick}
                onLabelMouseOver={onLabelMouseOver}
                onLabelMouseOut={onLabelMouseOut}
                readonly={readonly}
                displayValues={getDisplayValues(sourceIndex, item)}
                className={styles.virtualRow}
                rowIndex={row.index + 2}
              />
            );
          })}
          <VirtualTableSpacer columnCount={columnCount} size={bottomSpacerSize} />
        </tbody>
      </table>
    </div>
  );
}

function LegendTableColGroup({ valueColumnCount }: { valueColumnCount: number }) {
  return (
    <colgroup>
      <col />
      {valueColumnCount > 0 && <col span={valueColumnCount} style={{ width: TABLE_VALUE_COLUMN_WIDTH }} />}
    </colgroup>
  );
}

function VirtualTableSpacer({ columnCount, size }: { columnCount: number; size: number }) {
  if (size <= 0) {
    return null;
  }

  return (
    <tr aria-hidden style={{ height: size }}>
      <td colSpan={columnCount} style={{ border: 0, height: size, padding: 0 }} />
    </tr>
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
  headerContent: css({
    alignItems: 'center',
    display: 'flex',
    minWidth: 0,
  }),
  valueHeaderContent: css({
    justifyContent: 'flex-end',
  }),
  headerLabel: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  headerSortIcon: css({
    display: 'inline-flex',
    flexShrink: 0,
  }),
  virtualScroll: css({
    height: '100%',
    minHeight: VIRTUAL_ROW_HEIGHT * 3,
    overflow: 'auto',
    width: '100%',
  }),
  fixedTable: css({
    borderSpacing: 0,
    tableLayout: 'fixed',
    'td:first-child': {
      overflow: 'hidden',
    },
    'th:not(:first-child)': {
      overflow: 'hidden',
    },
    'td:not(:first-child)': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
  }),
  virtualHeader: css({
    background: theme.colors.background.primary,
    'th:not(.sr-only)': {
      background: theme.colors.background.primary,
      position: 'sticky',
      top: 0,
      zIndex: 1,
    },
  }),
  virtualRow: css({
    height: VIRTUAL_ROW_HEIGHT,
  }),
});
