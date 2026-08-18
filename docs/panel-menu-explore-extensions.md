---
title: Configure panel Explore actions
---

# Configure panel Explore actions

This fork provides two independent settings in the `[explore]` section of your Grafana configuration:

- `panel_menu_label` overrides the native dashboard panel-menu Explore label. The default is empty, which keeps the existing localized label.
- `panel_menu_extension_first` places the first available top-level Explore extension before native Explore. The default is `false`, which preserves the existing menu order.

For example, you can configure an alternative workflow without naming an integration in the fork:

```ini
[explore]
panel_menu_label = Built-in Explore
panel_menu_extension_first = true
```

You can also set `GF_EXPLORE_PANEL_MENU_LABEL` and `GF_EXPLORE_PANEL_MENU_EXTENSION_FIRST` in the server environment.

Explore extensions use the existing `top-level` link category and a title ending in `Explore`. Their configured titles, destinations, and click handlers remain unchanged. Use the link's `configure` callback to return `undefined` for unsupported panels. If no matching extension is available, no extension is promoted. Embedded dashboards continue to omit extensions.

Product-specific names, destinations, and release labels belong in your app plugin. Keep its link registration title and declared extension title in `plugin.json` consistent.
