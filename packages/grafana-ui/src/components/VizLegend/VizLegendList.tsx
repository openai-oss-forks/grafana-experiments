import { css, cx } from '@emotion/css';
import { KeyboardEvent, useMemo, useRef } from 'react';

import { GrafanaTheme2 } from '@grafana/data';

import { useStyles2 } from '../../themes/ThemeContext';
import { InlineList } from '../List/InlineList';
import { List } from '../List/List';
import { useFixedVirtualWindow } from '../Virtualization/useFixedVirtualWindow';

import { VizLegendListItem } from './VizLegendListItem';
import { VizLegendBaseProps, VizLegendItem, VizLegendItemSource } from './types';

export interface Props<T> extends VizLegendBaseProps<T> {}

const VIRTUALIZE_THRESHOLD = 200;
const VIRTUAL_ROW_HEIGHT = 28;
const VIRTUAL_COLUMN_WIDTH = 180;
const VIRTUAL_OVERSCAN = 12;

/**
 * @internal
 */
export const VizLegendList = <T extends unknown>({
  items,
  itemSource,
  itemRenderer,
  onLabelMouseOver,
  onLabelMouseOut,
  onLabelClick,
  placement,
  className,
  readonly,
  getItemDisplayValues,
}: Props<T>) => {
  const styles = useStyles2(getStyles);

  if (itemSource) {
    return (
      <IndexedVizLegendList
        className={className}
        getItemDisplayValues={getItemDisplayValues}
        itemRenderer={itemRenderer}
        itemSource={itemSource}
        onLabelClick={onLabelClick}
        onLabelMouseOut={onLabelMouseOut}
        onLabelMouseOver={onLabelMouseOver}
        placement={placement}
        readonly={readonly}
      />
    );
  }

  if (!itemRenderer) {
    /* eslint-disable-next-line react/display-name */
    itemRenderer = (item) => (
      <VizLegendListItem
        item={item}
        onLabelClick={onLabelClick}
        onLabelMouseOver={onLabelMouseOver}
        onLabelMouseOut={onLabelMouseOut}
        readonly={readonly}
      />
    );
  }

  const getItemKey = (item: VizLegendItem<T>) => `${item.getItemKey ? item.getItemKey() : item.label}`;

  switch (placement) {
    case 'right': {
      const renderItem = (item: VizLegendItem<T>, index: number) => {
        return <span className={styles.itemRight}>{itemRenderer!(item, index)}</span>;
      };

      return (
        <div className={cx(styles.rightWrapper, className)}>
          <List items={items} renderItem={renderItem} getItemKey={getItemKey} />
        </div>
      );
    }
    case 'bottom':
    default: {
      const leftItems = items.filter((item) => item.yAxis === 1);
      const rightItems = items.filter((item) => item.yAxis !== 1);

      const renderItem = (item: VizLegendItem<T>, index: number) => {
        return <span className={styles.itemBottom}>{itemRenderer!(item, index)}</span>;
      };

      return (
        <div className={cx(styles.bottomWrapper, className)}>
          {leftItems.length > 0 && (
            <div className={styles.section}>
              <InlineList items={leftItems} renderItem={renderItem} getItemKey={getItemKey} />
            </div>
          )}
          {rightItems.length > 0 && (
            <div className={cx(styles.section, styles.sectionRight)}>
              <InlineList items={rightItems} renderItem={renderItem} getItemKey={getItemKey} />
            </div>
          )}
        </div>
      );
    }
  }
};

function IndexedVizLegendList<T>({
  className,
  getItemDisplayValues,
  itemRenderer,
  itemSource,
  onLabelClick,
  onLabelMouseOut,
  onLabelMouseOver,
  placement,
  readonly,
}: Omit<Props<T>, 'items' | 'itemSource'> & { itemSource: VizLegendItemSource<T> }) {
  const styles = useStyles2(getStyles);
  const renderItem = (source: VizLegendItemSource<T>, item: VizLegendItem<T>, index: number) =>
    itemRenderer ? (
      itemRenderer(item, index)
    ) : (
      <VizLegendListItem
        item={item}
        onLabelClick={onLabelClick}
        onLabelMouseOver={onLabelMouseOver}
        onLabelMouseOut={onLabelMouseOut}
        readonly={readonly}
        displayValues={source.getDisplayValues?.(index) ?? getItemDisplayValues?.(item)}
      />
    );

  const axisSources = useMemo(() => {
    if (placement !== 'bottom') {
      return undefined;
    }
    if (!itemSource.getItemsForYAxis) {
      throw new Error('Bottom indexed legends require getItemsForYAxis');
    }
    return [itemSource.getItemsForYAxis(1), itemSource.getItemsForYAxis(2)] as const;
  }, [itemSource, placement]);

  if (axisSources) {
    return (
      <div className={cx(styles.bottomWrapper, className)}>
        {axisSources[0].length > 0 && (
          <div className={styles.section}>
            <IndexedVizLegendGroup<T>
              itemSource={axisSources[0]}
              itemRenderer={(item, index) => renderItem(axisSources[0], item, index)}
              horizontal
            />
          </div>
        )}
        {axisSources[1].length > 0 && (
          <div className={cx(styles.section, styles.sectionRight)}>
            <IndexedVizLegendGroup<T>
              itemSource={axisSources[1]}
              itemRenderer={(item, index) => renderItem(axisSources[1], item, index)}
              horizontal
            />
          </div>
        )}
      </div>
    );
  }

  if (itemSource.length > VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualizedVizLegendList<T>
        className={className}
        itemCount={itemSource.length}
        itemRenderer={(item, index) => renderItem(itemSource, item, index)}
        getItem={(index) => itemSource.getItem(index)}
        getItemKey={(index) => itemSource.getItemKey(index)}
        horizontal={placement === 'bottom'}
      />
    );
  }

  const renderedItems = [];
  for (let index = 0; index < itemSource.length; index++) {
    const item = itemSource.getItem(index);
    renderedItems.push(
      <span className={placement === 'right' ? styles.itemRight : styles.itemBottom} key={itemSource.getItemKey(index)}>
        {renderItem(itemSource, item, index)}
      </span>
    );
  }

  return (
    <div className={cx(placement === 'right' ? styles.rightWrapper : styles.bottomWrapper, className)}>
      {renderedItems}
    </div>
  );
}

function IndexedVizLegendGroup<T>({
  horizontal,
  itemRenderer,
  itemSource,
}: {
  horizontal: boolean;
  itemRenderer: NonNullable<Props<T>['itemRenderer']>;
  itemSource: VizLegendItemSource<T>;
}) {
  const styles = useStyles2(getStyles);
  if (itemSource.length > VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualizedVizLegendList<T>
        itemCount={itemSource.length}
        itemRenderer={itemRenderer}
        getItem={(index) => itemSource.getItem(index)}
        getItemKey={(index) => itemSource.getItemKey(index)}
        horizontal={horizontal}
      />
    );
  }
  const items = [];
  for (let index = 0; index < itemSource.length; index++) {
    items.push(
      <li className={styles.indexedBottomListItem} key={itemSource.getItemKey(index)}>
        <span className={styles.itemBottom}>{itemRenderer(itemSource.getItem(index), index)}</span>
      </li>
    );
  }
  return <ul className={styles.indexedBottomList}>{items}</ul>;
}

function VirtualizedVizLegendList<T>({
  itemRenderer,
  getItemKey,
  className,
  itemCount,
  getItem,
  horizontal = false,
}: {
  itemRenderer: NonNullable<Props<T>['itemRenderer']>;
  getItemKey: (index: number) => React.Key;
  className?: string;
  itemCount: number;
  getItem: (index: number) => VizLegendItem<T>;
  horizontal?: boolean;
}) {
  const styles = useStyles2(getStyles);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemSize = horizontal ? VIRTUAL_COLUMN_WIDTH : VIRTUAL_ROW_HEIGHT;
  const virtualWindow = useFixedVirtualWindow({
    containerRef: scrollRef,
    count: itemCount,
    horizontal,
    itemSize,
    overscan: VIRTUAL_OVERSCAN,
    initialViewportSize: horizontal ? VIRTUAL_COLUMN_WIDTH * 5 : VIRTUAL_ROW_HEIGHT * 12,
  });
  const focusItem = (index: number) => {
    const nextIndex = Math.max(0, Math.min(itemCount - 1, index));
    virtualWindow.scrollToIndex(nextIndex);
    window.requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLButtonElement>(`[data-index="${nextIndex}"] button`)?.focus();
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focusedRow = document.activeElement?.closest('[data-index]');
    const currentIndex = focusedRow instanceof HTMLElement ? Number(focusedRow.dataset.index) : -1;
    if (event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) {
      event.preventDefault();
      focusItem(currentIndex + 1);
    } else if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) {
      event.preventDefault();
      focusItem(currentIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(itemCount - 1);
    }
  };

  return (
    <div
      ref={scrollRef}
      className={cx(horizontal ? styles.virtualScrollHorizontal : styles.virtualScroll, className)}
      role="toolbar"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div
        className={horizontal ? styles.virtualContentHorizontal : styles.virtualContent}
        style={horizontal ? { width: virtualWindow.totalSize } : { height: virtualWindow.totalSize }}
      >
        {virtualWindow.virtualItems.map((row) => {
          const item = getItem(row.index);
          return (
            <div
              key={getItemKey(row.index)}
              data-index={row.index}
              className={horizontal ? styles.virtualRowHorizontal : styles.virtualRow}
              style={{ transform: horizontal ? `translateX(${row.start}px)` : `translateY(${row.start}px)` }}
              title={item.label}
            >
              {itemRenderer(item, row.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

VizLegendList.displayName = 'VizLegendList';

const getStyles = (theme: GrafanaTheme2) => {
  const itemStyles = css({
    paddingRight: '10px',
    display: 'flex',
    fontSize: theme.typography.bodySmall.fontSize,
    whiteSpace: 'nowrap',
  });

  return {
    itemBottom: itemStyles,
    itemRight: cx(
      itemStyles,
      css({
        marginBottom: theme.spacing(0.5),
      })
    ),
    rightWrapper: css({
      padding: theme.spacing(0.5),
    }),
    bottomWrapper: css({
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      width: '100%',
      padding: theme.spacing(0.5),
      gap: '15px 25px',
    }),
    section: css({
      display: 'flex',
    }),
    sectionRight: css({
      justifyContent: 'flex-end',
      flexGrow: 1,
      flexBasis: '50%',
    }),
    indexedBottomList: css({
      listStyleType: 'none',
      margin: 0,
      padding: 0,
    }),
    indexedBottomListItem: css({ display: 'inline-block' }),
    virtualScroll: css({
      height: '100%',
      minHeight: VIRTUAL_ROW_HEIGHT * 3,
      overflowY: 'auto',
      padding: theme.spacing(0.5),
      width: '100%',
    }),
    virtualScrollHorizontal: css({
      overflowX: 'auto',
      padding: theme.spacing(0.5),
      width: '100%',
    }),
    virtualContent: css({
      position: 'relative',
      width: '100%',
    }),
    virtualContentHorizontal: css({
      height: VIRTUAL_ROW_HEIGHT,
      position: 'relative',
    }),
    virtualRow: css({
      alignItems: 'center',
      display: 'flex',
      left: 0,
      minHeight: VIRTUAL_ROW_HEIGHT,
      position: 'absolute',
      top: 0,
      width: '100%',
    }),
    virtualRowHorizontal: css({
      alignItems: 'center',
      display: 'flex',
      height: VIRTUAL_ROW_HEIGHT,
      left: 0,
      overflow: 'hidden',
      position: 'absolute',
      top: 0,
      width: VIRTUAL_COLUMN_WIDTH,
    }),
  };
};
