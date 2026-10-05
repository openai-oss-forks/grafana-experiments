package conversion

import (
	"testing"

	"github.com/stretchr/testify/require"

	dashv1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v1beta1"
	dashv2alpha1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2alpha1"
	dashv2beta1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v2beta1"
)

func TestVariableHideConversion(t *testing.T) {
	scheme := setupTestConversionScheme(t)

	tests := []struct {
		name   string
		input  interface{}
		wantV2 string
		wantV1 int
	}{
		{"visible", 0, "dontHide", 0},
		{"hide label", 1, "hideLabel", 1},
		{"hide variable", 2, "hideVariable", 2},
		{"controls menu integer", 3, "inControlsMenu", 3},
		{"controls menu JSON number", float64(3), "inControlsMenu", 3},
		{"controls menu string", "inControlsMenu", "inControlsMenu", 3},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			original := &dashv1.Dashboard{Spec: dashv1.DashboardSpec{Object: map[string]interface{}{
				"title": "Variable hide conversion",
				"templating": map[string]interface{}{"list": []interface{}{
					map[string]interface{}{"name": "example", "type": "textbox", "hide": tt.input},
				}},
			}}}

			var converted dashv2alpha1.Dashboard
			require.NoError(t, scheme.Convert(original, &converted, nil))
			require.Len(t, converted.Spec.Variables, 1)
			require.NotNil(t, converted.Spec.Variables[0].TextVariableKind)
			require.Equal(t, tt.wantV2, string(converted.Spec.Variables[0].TextVariableKind.Spec.Hide))

			var roundTrip dashv1.Dashboard
			require.NoError(t, scheme.Convert(&converted, &roundTrip, nil))
			templating, ok := roundTrip.Spec.Object["templating"].(map[string]interface{})
			require.True(t, ok)
			variables, ok := templating["list"].([]map[string]interface{})
			require.True(t, ok)
			require.Len(t, variables, 1)
			require.Equal(t, tt.wantV1, variables[0]["hide"])
		})
	}
}

func TestControlsMenuHideV1beta1V2beta1RoundTrip(t *testing.T) {
	scheme := setupTestConversionScheme(t)
	original := &dashv1.Dashboard{Spec: dashv1.DashboardSpec{Object: map[string]interface{}{
		"title": "Variable hide conversion",
		"templating": map[string]interface{}{"list": []interface{}{
			map[string]interface{}{"name": "example", "type": "textbox", "hide": 3},
		}},
	}}}

	var converted dashv2beta1.Dashboard
	require.NoError(t, scheme.Convert(original, &converted, nil))
	require.Len(t, converted.Spec.Variables, 1)
	require.NotNil(t, converted.Spec.Variables[0].TextVariableKind)
	require.Equal(t, dashv2beta1.DashboardVariableHideInControlsMenu, converted.Spec.Variables[0].TextVariableKind.Spec.Hide)

	var roundTrip dashv1.Dashboard
	require.NoError(t, scheme.Convert(&converted, &roundTrip, nil))
	templating, ok := roundTrip.Spec.Object["templating"].(map[string]interface{})
	require.True(t, ok)
	variables, ok := templating["list"].([]map[string]interface{})
	require.True(t, ok)
	require.Len(t, variables, 1)
	require.Equal(t, 3, variables[0]["hide"])
}
