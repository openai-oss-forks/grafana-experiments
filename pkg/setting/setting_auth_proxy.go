package setting

import (
	"fmt"
	"strings"

	"github.com/grafana/grafana/pkg/util"
)

type AuthProxySettings struct {
	// Auth Proxy
	Enabled             bool
	HeaderName          string
	HeaderProperty      string
	AutoSignUp          bool
	EnableLoginToken    bool
	Whitelist           string
	Headers             map[string]string
	HeadersEncoded      bool
	SyncTTL             int
	SharedSecretEnabled bool
	SharedSecret        string
	SharedSecretHeader  string
}

func (cfg *Cfg) readAuthProxySettings() error {
	authProxySettings := AuthProxySettings{}
	authProxy := cfg.Raw.Section("auth.proxy")
	authProxySettings.Enabled = authProxy.Key("enabled").MustBool(false)
	authProxySettings.HeaderName = valueAsString(authProxy, "header_name", "")
	authProxySettings.HeaderProperty = valueAsString(authProxy, "header_property", "")
	authProxySettings.AutoSignUp = authProxy.Key("auto_sign_up").MustBool(true)
	authProxySettings.EnableLoginToken = authProxy.Key("enable_login_token").MustBool(false)
	authProxySettings.SyncTTL = authProxy.Key("sync_ttl").MustInt(15)
	authProxySettings.Whitelist = valueAsString(authProxy, "whitelist", "")
	if authProxy.HasKey("shared_secret_enabled") {
		sharedSecretEnabled, err := authProxy.Key("shared_secret_enabled").Bool()
		if err != nil {
			return fmt.Errorf("[auth.proxy].shared_secret_enabled must be true or false: %w", err)
		}
		authProxySettings.SharedSecretEnabled = sharedSecretEnabled
	}
	authProxySettings.SharedSecret = valueAsString(authProxy, "shared_secret", "")
	authProxySettings.SharedSecretHeader = valueAsString(authProxy, "shared_secret_header", "X-WEBAUTH-SECRET")
	if authProxySettings.SharedSecretEnabled && strings.TrimSpace(authProxySettings.SharedSecret) == "" {
		return fmt.Errorf("[auth.proxy].shared_secret must not be empty when shared_secret_enabled is true")
	}
	if authProxySettings.SharedSecretEnabled && strings.TrimSpace(authProxySettings.SharedSecretHeader) == "" {
		return fmt.Errorf("[auth.proxy].shared_secret_header must not be empty when shared_secret_enabled is true")
	}
	authProxySettings.Headers = make(map[string]string)
	headers := valueAsString(authProxy, "headers", "")

	for _, propertyAndHeader := range util.SplitString(headers) {
		split := strings.SplitN(propertyAndHeader, ":", 2)
		if len(split) == 2 {
			authProxySettings.Headers[split[0]] = split[1]
		}
	}

	authProxySettings.HeadersEncoded = authProxy.Key("headers_encoded").MustBool(false)

	cfg.AuthProxy = authProxySettings
	return nil
}
