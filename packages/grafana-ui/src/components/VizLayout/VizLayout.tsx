import { css } from '@emotion/css';
import { FC, CSSProperties, ComponentType } from 'react';
import * as React from 'react';
import { useMeasure } from 'react-use';

import { GrafanaTheme2 } from '@grafana/data';
import { LegendPlacement } from '@grafana/schema';

import { useStyles2, useTheme2 } from '../../themes/ThemeContext';
import { getFocusStyles } from '../../themes/mixins';
import { ScrollContainer } from '../ScrollContainer/ScrollContainer';

/**
 * @beta
 */
export interface VizLayoutProps {
  width: number;
  height: number;
  legend?: React.ReactElement<VizLayoutLegendProps> | null;
  /** Keep the first measured legend rectangle stable until the layout dimensions or placement change. */
  lockLegendSize?: boolean;
  /** Identifies the visible render session whose legend geometry is retained. */
  legendSizeKey?: string | number;
  /** Mount the visualization at full size when a present legend has no measurable rectangle. */
  mountBeforeLegendMeasure?: boolean;
  /** Preserve the same plot wrapper tree when legend visibility changes. */
  stableLegendSlot?: boolean;
  children: (width: number, height: number) => React.ReactNode;
}

/**
 * @beta
 */
export interface VizLayoutComponentType extends FC<VizLayoutProps> {
  Legend: ComponentType<VizLayoutLegendProps>;
}

/**
 * @beta
 *
 * https://developers.grafana.com/ui/latest/index.html?path=/docs/plugins-vizlayout--docs
 */
export const VizLayout: VizLayoutComponentType = ({
  width,
  height,
  legend,
  lockLegendSize = false,
  legendSizeKey = '',
  mountBeforeLegendMeasure = false,
  stableLegendSlot = false,
  children,
}) => {
  const theme = useTheme2();
  const styles = useStyles2(getVizStyles);
  const containerStyle: CSSProperties = {
    display: 'flex',
    width: `${width}px`,
    height: `${height}px`,
  };
  const [legendRef, legendMeasure] = useMeasure<HTMLDivElement>();
  const legendElement = React.useRef<HTMLDivElement | null>(null);
  const [lockedLegendMeasure, setLockedLegendMeasure] = React.useState<{
    key: string;
    width: number;
    height: number;
  }>();

  let placement = legend?.props.placement;
  const maxHeight = legend?.props.maxHeight ?? '35%';
  const maxWidth = legend?.props.maxWidth ?? '60%';

  if (legend && document.body.clientWidth < theme.breakpoints.values.lg) {
    placement = 'bottom';
  }

  const legendMeasureKey = legend
    ? `${legendSizeKey}:${placement}:${width}:${height}:${maxHeight}:${maxWidth}:${legend.props.width ?? ''}`
    : '';
  const setLegendRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      legendElement.current = element;
      legendRef(element!);
    },
    [legendRef]
  );
  const lockedLegendKey = lockedLegendMeasure?.key;

  React.useLayoutEffect(() => {
    if (!lockLegendSize || !legend || !legendElement.current) {
      setLockedLegendMeasure(undefined);
      return;
    }
    if (lockedLegendKey === legendMeasureKey) {
      return;
    }
    const rectangle = legendElement.current.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) {
      setLockedLegendMeasure(undefined);
      return;
    }
    setLockedLegendMeasure((current) => {
      if (
        current?.key === legendMeasureKey &&
        current.width === rectangle.width &&
        current.height === rectangle.height
      ) {
        return current;
      }
      return { key: legendMeasureKey, width: rectangle.width, height: rectangle.height };
    });
  }, [legend, legendMeasure.height, legendMeasure.width, legendMeasureKey, lockLegendSize, lockedLegendKey]);

  if (!legend) {
    if (stableLegendSlot) {
      return (
        <div style={containerStyle}>
          <div className={styles.viz}>{children(width, height)}</div>
          <div style={{ display: 'none' }} />
        </div>
      );
    }
    return (
      <>
        <div style={containerStyle} className={styles.viz}>
          {children(width, height)}
        </div>
      </>
    );
  }

  const activeLockedLegend =
    lockLegendSize && lockedLegendMeasure?.key === legendMeasureKey ? lockedLegendMeasure : undefined;
  const measuredLegend = activeLockedLegend ?? legendMeasure;

  let size: VizSize | null = mountBeforeLegendMeasure ? { width, height } : null;

  const legendStyle: CSSProperties = {};

  switch (placement) {
    case 'bottom':
      containerStyle.flexDirection = 'column';
      legendStyle.maxHeight = maxHeight;
      if (measuredLegend.height) {
        if (activeLockedLegend) {
          legendStyle.height = measuredLegend.height;
        }
        size = { width, height: height - measuredLegend.height };
      }
      break;
    case 'right':
      containerStyle.flexDirection = 'row';
      legendStyle.maxWidth = maxWidth;

      if (measuredLegend.width) {
        if (activeLockedLegend && !legend.props.width) {
          legendStyle.width = measuredLegend.width;
        }
        size = { width: width - measuredLegend.width, height };
      }

      if (legend.props.width) {
        legendStyle.width = legend.props.width;
        size = { width: width - legend.props.width, height };
      }
      break;
  }

  // This happens when position is switched from bottom to right
  // Then we preserve old with for one render cycle until legend is measured in it's new position
  if (size?.width === 0) {
    size.width = width;
  }

  if (size?.height === 0) {
    size.height = height;
  }

  return (
    <div style={containerStyle}>
      <div className={styles.viz}>{size && children(size.width, size.height)}</div>
      <div style={legendStyle} ref={setLegendRef}>
        <ScrollContainer>{legend}</ScrollContainer>
      </div>
    </div>
  );
};

export const getVizStyles = (theme: GrafanaTheme2) => {
  return {
    viz: css({
      flexGrow: 2,
      borderRadius: theme.shape.radius.default,
      '&:focus-visible': getFocusStyles(theme),
    }),
  };
};
interface VizSize {
  width: number;
  height: number;
}

/**
 * @beta
 */
export interface VizLayoutLegendProps {
  placement: LegendPlacement;
  children: React.ReactNode;
  maxHeight?: string;
  maxWidth?: string;
  width?: number;
}

/**
 * @beta
 */
export const VizLayoutLegend: FC<VizLayoutLegendProps> = ({ children }) => {
  return <>{children}</>;
};

VizLayout.Legend = VizLayoutLegend;
