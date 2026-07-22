import { css } from '@emotion/react';

import { GrafanaTheme2 } from '@grafana/data';

export function getDashboardGridStyles(theme: GrafanaTheme2) {
  return css({
    '.react-resizable-handle': {
      // this needs to use visibility and not display none in order not to cause resize flickering
      visibility: 'hidden',
    },

    '.react-grid-item, #grafana-portal-container': {
      touchAction: 'initial !important',

      '&:hover': {
        '.react-resizable-handle': {
          visibility: 'visible',
        },
      },
    },

    '.dragging-active': {
      '*': {
        cursor: 'move',
        userSelect: 'none',
      },
    },

    [theme.breakpoints.down('md')]: {
      '.react-grid-layout': {
        height: 'unset !important',
      },
      '.react-grid-item': {
        display: 'block !important',
        transitionProperty: 'none !important',
        // can't avoid type assertion here due to !important
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        position: 'unset !important' as 'unset',
        transform: 'translate(0px, 0px) !important',
        marginBottom: theme.spacing(2),
      },
      '.panel-repeater-grid-item': {
        height: 'auto !important',
      },
    },

    '.react-grid-item.react-grid-placeholder': {
      boxShadow: `0 0 4px ${theme.colors.primary.border} !important`,
      background: `${theme.colors.primary.transparent} !important`,
      zIndex: '-1 !important',
      opacity: 'unset !important',
    },

    '.react-grid-item > .react-resizable-handle::after': {
      borderRight: `2px solid ${theme.isDark ? theme.v1.palette.gray1 : theme.v1.palette.gray3} !important`,
      borderBottom: `2px solid ${theme.isDark ? theme.v1.palette.gray1 : theme.v1.palette.gray3} !important`,
    },

    // Hack for preventing panel menu overlapping.
    '.react-grid-item.resizing.panel, .react-grid-item.panel.dropdown-menu-open, .react-grid-item.react-draggable-dragging.panel':
      {
        zIndex: theme.zIndex.dropdown,
      },

    // Disable animation on initial rendering and enable it when component has been mounted.
    '.react-grid-item.cssTransforms': {
      // eslint-disable-next-line @grafana/no-unreduced-motion
      transitionProperty: 'none !important',
    },

    [theme.transitions.handleMotion('no-preference')]: {
      '.react-grid-layout--enable-move-animations': {
        '.react-grid-item.cssTransforms': {
          transitionProperty: 'transform !important',
        },
      },
    },

    '.dashboard-selected-element': {
      outline: `1px dashed ${theme.colors.primary.border}`,
      outlineOffset: '0px',
      borderRadius: theme.shape.radius.default,
    },

    // Keep the shortcut discoverable without introducing dashboard selection state.
    'div[data-viz-panel-key]:hover section': {
      position: 'relative',

      '&::before': {
        content: "'⌘C'",
        position: 'absolute',
        right: theme.spacing(1),
        bottom: theme.spacing(1),
        height: '18px',
        padding: `0 ${theme.spacing(0.5)}`,
        lineHeight: '18px',
        pointerEvents: 'none',
        border: `1px solid ${theme.colors.border.weak}`,
        borderRadius: theme.shape.radius.default,
        backgroundColor: theme.colors.background.secondary,
        color: theme.colors.text.secondary,
        fontSize: '11px',
        fontWeight: theme.typography.fontWeightMedium,
        zIndex: 2,
      },
    },

    // Brief, static confirmation for a successful panel copy. Only the top-right corner changes;
    // there is no animation or layout change.
    '.dashboard-copied-element': {
      position: 'relative',

      '&::after': {
        content: "''",
        position: 'absolute',
        top: 0,
        right: 0,
        width: theme.spacing(3),
        height: theme.spacing(3),
        pointerEvents: 'none',
        borderTop: `3px solid ${theme.colors.success.main}`,
        borderRight: `3px solid ${theme.colors.success.main}`,
        borderTopRightRadius: theme.shape.radius.default,
        zIndex: 2,
      },
    },

    '.dashboard-selectable-element': {
      '&:hover': {
        outline: `1px dashed ${theme.colors.border.strong}`,
        outlineOffset: '0px',
        borderRadius: theme.shape.radius.default,
        backgroundColor: theme.colors.emphasize(theme.colors.background.canvas, 0.08),
      },
    },

    '.dashboard-canvas-controls': {
      opacity: 0,

      '@media (hover: none) and (pointer: coarse)': {
        '&': {
          opacity: 1,
        },
      },

      [theme.transitions.handleMotion('no-preference', 'reduce')]: {
        transition: theme.transitions.create('opacity'),
      },

      '&:hover, :focus-within': {
        opacity: 1,
      },
    },

    '.dashboard-visible-hidden-element': {
      position: 'relative',
    },

    // Universal style for marking drop targets when dragging between layouts
    '.dashboard-drop-target': {
      // Setting same options for hovered and not hovered to overwrite any conflicting styles
      // There was a race condition with selectable elements styles
      '&:is(:hover),&:not(:hover)': {
        outline: `2px solid ${theme.colors.primary.border}`,
        outlineOffset: '0px',
        borderRadius: theme.shape.radius.default,
      },
    },

    // Body style for preventing selection when dragging
    '.dashboard-draggable-transparent-selection': {
      '*::selection': {
        all: 'inherit',
      },
    },

    '.react-draggable-dragging': {
      opacity: 0.8,
    },
  });
}
