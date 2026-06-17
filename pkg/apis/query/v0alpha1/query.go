package v0alpha1

import (
	"encoding/json"
	"net/http"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	data "github.com/grafana/grafana-plugin-sdk-go/experimental/apis/data/v0alpha1"

	"github.com/grafana/grafana/pkg/plugins/backendplugin/querydataresponse"
)

const OpenAPIPrefix = "com.github.grafana.grafana.pkg.apis.query.v0alpha1."

// Generic query request with shared time across all values
// Copied from: https://github.com/grafana/grafana/blob/main/pkg/api/dtos/models.go#L62
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
type QueryDataRequest struct {
	metav1.TypeMeta `json:",inline"`

	// The time range used when not included on each query
	data.QueryDataRequest `json:",inline"`
}

func (QueryDataRequest) OpenAPIModelName() string {
	return OpenAPIPrefix + "QueryDataRequest"
}

// Wraps backend.QueryDataResponse, however it includes TypeMeta and implements runtime.Object
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
type QueryDataResponse struct {
	metav1.TypeMeta `json:",inline"`

	// Backend wrapper (external dependency)
	backend.QueryDataResponse `json:",inline"`

	ProxiedUpstreamHeaders querydataresponse.ProxiedUpstreamHeaders `json:"proxied_upstream_headers,omitempty"`
}

func NewQueryDataResponse(response *backend.QueryDataResponse) *QueryDataResponse {
	wrapped := querydataresponse.New(response)
	return &QueryDataResponse{
		QueryDataResponse:      backend.QueryDataResponse{Responses: wrapped.Results},
		ProxiedUpstreamHeaders: wrapped.ProxiedUpstreamHeaders,
	}
}

func (r QueryDataResponse) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		metav1.TypeMeta        `json:",inline"`
		Results                backend.Responses                        `json:"results"`
		ProxiedUpstreamHeaders querydataresponse.ProxiedUpstreamHeaders `json:"proxied_upstream_headers,omitempty"`
	}{
		TypeMeta:               r.TypeMeta,
		Results:                r.Responses,
		ProxiedUpstreamHeaders: r.ProxiedUpstreamHeaders,
	})
}

func (r *QueryDataResponse) UnmarshalJSON(data []byte) error {
	decoded := struct {
		metav1.TypeMeta        `json:",inline"`
		Results                backend.Responses                        `json:"results"`
		ProxiedUpstreamHeaders querydataresponse.ProxiedUpstreamHeaders `json:"proxied_upstream_headers,omitempty"`
	}{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	r.TypeMeta = decoded.TypeMeta
	r.QueryDataResponse = backend.QueryDataResponse{Responses: decoded.Results}
	r.ProxiedUpstreamHeaders = decoded.ProxiedUpstreamHeaders
	return nil
}

func (QueryDataResponse) OpenAPIModelName() string {
	return OpenAPIPrefix + "QueryDataResponse"
}

// GetResponseCode return the right status code for the response by checking the responses.
func GetResponseCode(rsp *backend.QueryDataResponse) int {
	if rsp == nil {
		return http.StatusBadRequest // rsp is nil, so we return a 400
	}
	for _, res := range rsp.Responses {
		if res.Error != nil && res.Status != 0 {
			return int(res.Status)
		}

		if res.Error != nil {
			return http.StatusBadRequest // Status is nil but we have an error, so we return a 400
		}
	}
	return http.StatusOK
}

// Defines a query behavior in a datasource.  This is a similar model to a CRD where the
// payload describes a valid query
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
type QueryTypeDefinition struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec data.QueryTypeDefinitionSpec `json:"spec,omitempty"`
}

func (QueryTypeDefinition) OpenAPIModelName() string {
	return OpenAPIPrefix + "QueryTypeDefinition"
}

// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
type QueryTypeDefinitionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`

	Items []QueryTypeDefinition `json:"items"`
}

func (QueryTypeDefinitionList) OpenAPIModelName() string {
	return OpenAPIPrefix + "QueryTypeDefinitionList"
}
