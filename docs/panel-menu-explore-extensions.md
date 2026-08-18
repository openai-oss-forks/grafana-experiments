---
title: Configure panel Explore actions
---

# Configure panel Explore actions

This fork lets you configure the native dashboard panel-menu Explore label and lets app plugins choose positions for their top-level menu links.

## Configure the native label

Set `panel_menu_label` in the `[explore]` section of your Grafana configuration. The default is empty, which keeps the existing localized label.

```ini
[explore]
panel_menu_label = Built-in Explore
```

You can also set `GF_EXPLORE_PANEL_MENU_LABEL` in the server environment.

## Position a plugin action

Register a link for `PluginExtensionPoints.DashboardPanelMenu` with `category: 'top-level'` and an optional `panelMenuPosition`:

```ts
plugin.addLink({
  targets: [PluginExtensionPoints.DashboardPanelMenu],
  category: 'top-level',
  panelMenuPosition: 0,
  title: 'Run analysis',
  description: 'Analyze the current panel',
  path: '/a/grafana-example-app/analysis',
});
```

Positions are zero-based indexes in the completed panel menu: `0` is first and `1` is second. Links with the same position keep their existing relative order. Positions beyond the end append the link. Omitted, negative, and non-integer positions preserve the default placement. Positions do not affect nested extension links.

The position does not depend on the link's title. Existing titles, destinations, click handlers, shortcuts, and edit-mode visibility remain unchanged. Use the link's `configure` callback to override its position or return `undefined` for unsupported panels. Embedded dashboards continue to omit extensions.

Product-specific names, destinations, and release labels belong in your app plugin. Keep its link registration title and declared extension title in `plugin.json` consistent.
