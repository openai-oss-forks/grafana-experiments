import { css } from '@emotion/css';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CSSProperties, ReactNode, useRef } from 'react';

import { GrafanaTheme2 } from '@grafana/data';

import { useStyles2 } from '../../themes/ThemeContext';

import { VizTooltipRow } from './VizTooltipRow';
import { VizTooltipItem } from './types';

interface VizTooltipContentProps {
  items: VizTooltipItem[];
  children?: ReactNode;
  scrollable?: boolean;
  isPinned: boolean;
  maxHeight?: number;
}

const VIRTUALIZE_THRESHOLD = 200;
const VIRTUAL_ROW_HEIGHT = 24;
const DEFAULT_VIRTUAL_HEIGHT = 400;

export const VizTooltipContent = ({
  items,
  children,
  isPinned,
  scrollable = false,
  maxHeight,
}: VizTooltipContentProps) => {
  const styles = useStyles2(getStyles);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    overscan: 12,
  });

  const scrollableStyle: CSSProperties = scrollable
    ? {
        maxHeight: maxHeight,
        overflowY: 'auto',
      }
    : {};

  if (items.length > VIRTUALIZE_THRESHOLD) {
    return (
      <div
        ref={scrollRef}
        className={styles.wrapper}
        style={{ height: maxHeight ?? DEFAULT_VIRTUAL_HEIGHT, overflowY: 'auto' }}
        role="list"
      >
        <div className={styles.virtualContent} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                role="listitem"
                aria-posinset={row.index + 1}
                aria-setsize={items.length}
                className={styles.virtualRow}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <VizTooltipRow
                  label={item.label}
                  value={item.value}
                  color={item.color}
                  colorIndicator={item.colorIndicator}
                  colorPlacement={item.colorPlacement}
                  isActive={item.isActive}
                  isPinned={isPinned}
                  lineStyle={item.lineStyle}
                  showValueScroll={false}
                  isHiddenFromViz={item.isHiddenFromViz}
                />
              </div>
            );
          })}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className={styles.wrapper} style={scrollableStyle}>
      {items.map(({ label, value, color, colorIndicator, colorPlacement, isActive, lineStyle, isHiddenFromViz }, i) => (
        <VizTooltipRow
          key={i}
          label={label}
          value={value}
          color={color}
          colorIndicator={colorIndicator}
          colorPlacement={colorPlacement}
          isActive={isActive}
          isPinned={isPinned}
          lineStyle={lineStyle}
          showValueScroll={!scrollable}
          isHiddenFromViz={isHiddenFromViz}
        />
      ))}
      {children}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    gap: 2,
    borderTop: `1px solid ${theme.colors.border.weak}`,
    padding: theme.spacing(1),
  }),
  virtualContent: css({
    position: 'relative',
    width: '100%',
  }),
  virtualRow: css({
    left: 0,
    minHeight: VIRTUAL_ROW_HEIGHT,
    position: 'absolute',
    top: 0,
    width: '100%',
  }),
});
