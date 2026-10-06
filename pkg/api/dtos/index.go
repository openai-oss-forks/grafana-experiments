package dtos

import (
	"html/template"

	"github.com/grafana/grafana/pkg/services/navtree"
)

type IndexViewData struct {
	User                                *CurrentUser         `json:"user"`
	Settings                            *FrontendSettingsDTO `json:"settings"`
	AppUrl                              string               `json:"-"`
	AppSubUrl                           string               `json:"-"`
	GoogleAnalyticsId                   string               `json:"-"`
	GoogleAnalytics4Id                  string               `json:"-"`
	GoogleAnalytics4SendManualPageViews bool                 `json:"-"`
	GoogleTagManagerId                  string               `json:"-"`
	NavTree                             *navtree.NavTreeRoot `json:"navTree"`
	BuildVersion                        string               `json:"-"`
	BuildCommit                         string               `json:"-"`
	ThemeType                           string               `json:"-"`
	NewGrafanaVersionExists             bool                 `json:"-"`
	NewGrafanaVersion                   string               `json:"-"`
	AppName                             string               `json:"-"`
	AppNameBodyClass                    string               `json:"-"`
	FavIcon                             template.URL         `json:"-"`
	AppleTouchIcon                      template.URL         `json:"-"`
	AppTitle                            string               `json:"-"`
	LoadingLogo                         template.URL         `json:"-"`
	CSPContent                          string               `json:"-"`
	CSPEnabled                          bool                 `json:"-"`
	IsDevelopmentEnv                    bool                 `json:"-"`
	// Nonce is a cryptographic identifier for use with Content Security Policy.
	Nonce           string            `json:"-"`
	NewsFeedEnabled bool              `json:"-"`
	Assets          *EntryPointAssets `json:"assets"` // Includes CDN info
}

type EntryPointAssets struct {
	ContentDeliveryURL string            `json:"cdn,omitempty"`
	JSFiles            []EntryPointAsset `json:"jsFiles"`
	EmbeddedJSFiles    []EntryPointAsset `json:"embeddedJsFiles,omitempty"`
	EmbeddedCSSFiles   []EntryPointAsset `json:"embeddedCssFiles,omitempty"`
	CSSFiles           []EntryPointAsset `json:"cssFiles"`
	Dark               string            `json:"dark"`
	Light              string            `json:"light"`
	Swagger            []EntryPointAsset `json:"swagger"`
	SwaggerCSSFiles    []EntryPointAsset `json:"swaggerCssFiles"`
}

type EntryPointAsset struct {
	FilePath  string `json:"filePath"`
	Integrity string `json:"integrity"`
}

func (a *EntryPointAssets) SetContentDeliveryURL(prefix string) {
	if prefix == "" {
		return
	}
	a.ContentDeliveryURL = prefix
	a.Dark = prefix + a.Dark
	a.Light = prefix + a.Light
	for i, p := range a.JSFiles {
		a.JSFiles[i].FilePath = prefix + p.FilePath
	}
	for i, p := range a.CSSFiles {
		a.CSSFiles[i].FilePath = prefix + p.FilePath
	}
	for i, p := range a.EmbeddedJSFiles {
		a.EmbeddedJSFiles[i].FilePath = prefix + p.FilePath
	}
	for i, p := range a.EmbeddedCSSFiles {
		a.EmbeddedCSSFiles[i].FilePath = prefix + p.FilePath
	}
	for i, p := range a.Swagger {
		a.Swagger[i].FilePath = prefix + p.FilePath
	}
	for i, p := range a.SwaggerCSSFiles {
		a.SwaggerCSSFiles[i].FilePath = prefix + p.FilePath
	}
}

// ForEmbeddedPanel selects the panel entrypoint without mutating the shared assets cache.
// Older/development manifests can still use the normal application entrypoint.
func (a *EntryPointAssets) ForEmbeddedPanel() *EntryPointAssets {
	if len(a.EmbeddedJSFiles) == 0 {
		return a
	}
	result := *a
	result.JSFiles = a.EmbeddedJSFiles
	result.CSSFiles = a.EmbeddedCSSFiles
	return &result
}
