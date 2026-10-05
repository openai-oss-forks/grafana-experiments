package v2alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDashboardVariableHideValidation(t *testing.T) {
	dashboard := NewDashboard()
	dashboard.Spec.Layout.GridLayoutKind = NewDashboardGridLayoutKind()
	variable := NewDashboardTextVariableKind()
	variable.Spec.Name = "example"
	variable.Spec.Hide = DashboardVariableHide("inControlsMenu")
	dashboard.Spec.Variables = []DashboardVariableKind{{TextVariableKind: variable}}

	require.Empty(t, ValidateDashboardSpec(dashboard))

	variable.Spec.Hide = DashboardVariableHide("invalid")
	require.NotEmpty(t, ValidateDashboardSpec(dashboard))
}
