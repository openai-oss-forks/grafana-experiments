---
title: Configure panel Explore actions
---

# Configure panel Explore actions

Set the native panel-menu Explore label in Grafana's configuration. An empty value keeps the localized default.

```ini
[explore]
panel_menu_label = Built-in Explore
```

The environment-variable equivalent is `GF_EXPLORE_PANEL_MENU_LABEL`. App plugins can independently position top-level panel-menu links:

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

Positions are zero-based: `0` is first. Ties keep their existing order; positions beyond the end append. Omitted, negative, or non-integer values preserve default placement. Nested links are unaffected. The link's `configure` callback can override its position or return `undefined` to hide it.

Positioning does not depend on titles or change shortcuts and visibility. Keep product-specific names and destinations in the app plugin, with matching registration and `plugin.json` titles.
