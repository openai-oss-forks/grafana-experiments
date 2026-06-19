import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { sceneGraph, VizPanel } from '@grafana/scenes';
import { useStyles2 } from '@grafana/ui';

interface DashboardPanelTitlePlaceholderProps {
  panel: VizPanel;
}

export function DashboardPanelTitlePlaceholder({ panel }: DashboardPanelTitlePlaceholderProps) {
  const { title } = panel.useState();
  const styles = useStyles2(getStyles);
  const interpolatedTitle = sceneGraph.interpolate(panel, title ?? '', undefined, 'text');

  // This node remains mounted after lazy loading so native browser Find keeps its active match.
  return (
    <div className={styles.panel} data-dashboard-panel-title-placeholder="">
      {interpolatedTitle && (
        <div className={styles.header}>
          <h2 className={styles.title} title={interpolatedTitle}>
            {interpolatedTitle}
          </h2>
        </div>
      )}
    </div>
  );
}

function getStyles(theme: GrafanaTheme2) {
  return {
    panel: css({
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      backgroundColor: theme.components.panel.background,
      border: `1px solid ${theme.components.panel.borderColor}`,
      borderRadius: theme.shape.radius.default,
      "[data-lazy-loaded='true'] > &": {
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        pointerEvents: 'none',
        backgroundColor: 'transparent',
        borderColor: 'transparent',
      },
      // Preserve the real header's layout while keeping this stable title as the sole visible Find match.
      "[data-lazy-loaded='true'] > & ~ * [data-viz-panel-key] [data-testid='data-testid header-container'] h2": {
        visibility: 'hidden',
      },
      "[data-lazy-loaded='true'] > & ~ * [data-dashboard-panel-title-placeholder]": {
        visibility: 'hidden',
      },
    }),
    header: css({
      display: 'flex',
      alignItems: 'center',
      height: theme.spacing.gridSize * theme.components.panel.headerHeight,
      minWidth: 0,
      padding: theme.spacing(0, 1),
    }),
    title: css({
      ...theme.typography.h6,
      minWidth: 0,
      margin: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
  };
}
