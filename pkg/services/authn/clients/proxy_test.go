package clients

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	claims "github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/authn"
	"github.com/grafana/grafana/pkg/services/authn/authntest"
	"github.com/grafana/grafana/pkg/setting"
)

func TestProxy_Authenticate(t *testing.T) {
	type testCase struct {
		desc               string
		req                *authn.Request
		ips                string
		proxyHeader        string
		proxyHeaders       map[string]string
		expectedErr        error
		expectedUsername   string
		expectedAdditional map[string]string
	}

	tests := []testCase{
		{
			desc: "should authenticate using passed in proxy client",
			ips:  "127.0.0.1",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{
						"X-Username": {"username"},
						"X-Name":     {"name"},
						"X-Email":    {"email"},
						"X-Login":    {"login"},
						"X-Role":     {"Viewer"},
						"X-Group":    {"grp1,grp2"},
					},
					RemoteAddr: "127.0.0.1:333",
				},
			},
			proxyHeader: "X-Username",
			proxyHeaders: map[string]string{
				proxyFieldName:   "X-Name",
				proxyFieldEmail:  "X-Email",
				proxyFieldLogin:  "X-Login",
				proxyFieldRole:   "X-Role",
				proxyFieldGroups: "X-Group",
			},
			expectedUsername: "username",
			expectedAdditional: map[string]string{
				proxyFieldName:   "name",
				proxyFieldEmail:  "email",
				proxyFieldLogin:  "login",
				proxyFieldRole:   "Viewer",
				proxyFieldGroups: "grp1,grp2",
			},
		},
		{
			desc: "should fail when proxy header is empty",
			req: &authn.Request{
				HTTPRequest: &http.Request{Header: map[string][]string{
					"X-Username": {""},
					"X-Name":     {"name"},
					"X-Email":    {"email"},
					"X-Login":    {"login"},
					"X-Role":     {"Viewer"},
					"X-Group":    {"grp1,grp2"},
				}},
			},
			proxyHeader: "X-Username",
			proxyHeaders: map[string]string{
				proxyFieldName:   "X-Name",
				proxyFieldEmail:  "X-Email",
				proxyFieldLogin:  "X-Login",
				proxyFieldRole:   "X-Role",
				proxyFieldGroups: "X-Group",
			},
			expectedErr: errEmptyProxyHeader,
		},
		{
			desc: "should fail when caller ip is not in accept list",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header:     map[string][]string{},
					RemoteAddr: "127.0.0.2:333",
				},
			},
			ips:         "127.0.0.1",
			expectedErr: errNotAcceptedIP,
		},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			cfg := setting.NewCfg()
			cfg.AuthProxy.HeaderName = "X-Username"
			cfg.AuthProxy.Headers = tt.proxyHeaders
			cfg.AuthProxy.Whitelist = tt.ips

			calledUsername := ""
			var calledAdditional map[string]string

			proxyClient := authntest.MockProxyClient{AuthenticateProxyFunc: func(ctx context.Context, r *authn.Request, username string, additional map[string]string) (*authn.Identity, error) {
				calledUsername = username
				calledAdditional = additional
				return nil, nil
			}}
			c, err := ProvideProxy(cfg, &fakeCache{expectedErr: errors.New("")}, tracing.InitializeTracerForTest(), proxyClient)
			require.NoError(t, err)

			_, err = c.Authenticate(context.Background(), tt.req)
			assert.ErrorIs(t, err, tt.expectedErr)
			assert.Equal(t, tt.expectedUsername, calledUsername)
			assert.EqualValues(t, tt.expectedAdditional, calledAdditional)
		})
	}
}

func TestProxy_Test(t *testing.T) {
	type testCase struct {
		desc         string
		req          *authn.Request
		sharedSecret string
		expectedOK   bool
	}

	tests := []testCase{
		{
			desc: "should return true when proxy header exists",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{"Proxy-Header": {"some value"}},
				},
			},
			expectedOK: true,
		},
		{
			desc: "should return false when proxy header exists but has no value",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{"Proxy-Header": {""}},
				},
			},
			expectedOK: false,
		},
		{
			desc: "should return false when no proxy header is set on request",
			req: &authn.Request{
				HTTPRequest: &http.Request{Header: map[string][]string{}},
			},
			expectedOK: false,
		},
		{
			desc:       "should return false when no http request is present",
			req:        &authn.Request{},
			expectedOK: false,
		},
		{
			desc:         "should return true when proxy and valid shared secret headers exist",
			sharedSecret: "secret",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{
						"Proxy-Header":  {"some value"},
						"Secret-Header": {"secret"},
					},
				},
			},
			expectedOK: true,
		},
		{
			desc:         "should return false when shared secret header is missing",
			sharedSecret: "secret",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{"Proxy-Header": {"some value"}},
				},
			},
			expectedOK: false,
		},
		{
			desc:         "should return false when shared secret header is invalid",
			sharedSecret: "secret",
			req: &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{
						"Proxy-Header":  {"some value"},
						"Secret-Header": {"wrong secret"},
					},
				},
			},
			expectedOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			cfg := setting.NewCfg()
			cfg.AuthProxy.HeaderName = "Proxy-Header"
			cfg.AuthProxy.SharedSecret = tt.sharedSecret
			cfg.AuthProxy.SharedSecretHeader = "Secret-Header"

			c, _ := ProvideProxy(cfg, nil, tracing.InitializeTracerForTest(), nil)
			assert.Equal(t, tt.expectedOK, c.Test(context.Background(), tt.req))
		})
	}
}

func TestProxy_Authenticate_SharedSecret(t *testing.T) {
	newProxy := func(t *testing.T, proxyClient authn.ProxyClient) *Proxy {
		t.Helper()
		cfg := setting.NewCfg()
		cfg.AuthProxy.HeaderName = "Proxy-Header"
		cfg.AuthProxy.SharedSecret = "secret"
		cfg.AuthProxy.SharedSecretHeader = "Secret-Header"

		c, err := ProvideProxy(cfg, &fakeCache{expectedErr: errors.New("")}, tracing.InitializeTracerForTest(), proxyClient)
		require.NoError(t, err)
		return c
	}

	t.Run("accepts a valid shared secret", func(t *testing.T) {
		called := false
		c := newProxy(t, authntest.MockProxyClient{AuthenticateProxyFunc: func(ctx context.Context, r *authn.Request, username string, additional map[string]string) (*authn.Identity, error) {
			called = true
			assert.Equal(t, "username", username)
			return nil, nil
		}})

		_, err := c.Authenticate(context.Background(), &authn.Request{HTTPRequest: &http.Request{Header: map[string][]string{
			"Proxy-Header":  {"username"},
			"Secret-Header": {"secret"},
		}}})
		require.NoError(t, err)
		assert.True(t, called)
	})

	for _, tc := range []struct {
		name   string
		header string
	}{
		{name: "rejects a missing shared secret", header: ""},
		{name: "rejects an invalid shared secret", header: "wrong secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			c := newProxy(t, authntest.MockProxyClient{AuthenticateProxyFunc: func(ctx context.Context, r *authn.Request, username string, additional map[string]string) (*authn.Identity, error) {
				called = true
				return nil, nil
			}})
			headers := map[string][]string{"Proxy-Header": {"username"}}
			if tc.header != "" {
				headers["Secret-Header"] = []string{tc.header}
			}

			_, err := c.Authenticate(context.Background(), &authn.Request{HTTPRequest: &http.Request{Header: headers}})
			assert.ErrorIs(t, err, errInvalidSharedSecret)
			assert.False(t, called)
		})
	}
}

var _ proxyCache = new(fakeCache)

type fakeCache struct {
	data        map[string][]byte
	expectedErr error
}

func (f *fakeCache) Get(ctx context.Context, key string) ([]byte, error) {
	return f.data[key], f.expectedErr
}

func (f *fakeCache) Set(ctx context.Context, key string, value []byte, expire time.Duration) error {
	f.data[key] = value
	return f.expectedErr
}

func (f fakeCache) Delete(ctx context.Context, key string) error {
	delete(f.data, key)
	return f.expectedErr
}

func TestProxy_Hook(t *testing.T) {
	cfg := setting.NewCfg()
	cfg.AuthProxy.HeaderName = "X-Username"
	cfg.AuthProxy.Headers = map[string]string{
		proxyFieldRole: "X-Role",
	}
	cache := &fakeCache{data: make(map[string][]byte)}

	// withRole creates a test case for a user with a specific role.
	withRole := func(role string) func(t *testing.T) {
		cacheKey := fmt.Sprintf("users:johndoe-%s", role)
		return func(t *testing.T) {
			c, err := ProvideProxy(cfg, cache, tracing.InitializeTracerForTest(), authntest.MockProxyClient{})
			require.NoError(t, err)
			userIdentity := &authn.Identity{
				ID:   "1",
				Type: claims.TypeUser,
				ClientParams: authn.ClientParams{
					CacheAuthProxyKey: cacheKey,
				},
			}
			userReq := &authn.Request{
				HTTPRequest: &http.Request{
					Header: map[string][]string{
						"X-Username": {"johndoe"},
						"X-Role":     {role},
					},
				},
			}
			err = c.Hook(context.Background(), userIdentity, userReq)
			assert.NoError(t, err)
			expectedCache := map[string][]byte{
				cacheKey: []byte("1"),
				fmt.Sprintf("%s:%s", proxyCachePrefix, "johndoe"): []byte(fmt.Sprintf("users:johndoe-%s", role)),
			}
			assert.Equal(t, expectedCache, cache.data)
		}
	}

	t.Run("step 1: new user with role Admin", withRole("Admin"))
	t.Run("step 2: cached user with new Role Viewer", withRole("Viewer"))
	t.Run("step 3: cached user get changed back to Admin", withRole("Admin"))
}
