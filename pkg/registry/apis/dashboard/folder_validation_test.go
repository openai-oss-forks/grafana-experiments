package dashboard

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apiserver/pkg/admission"

	dashv1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v1beta1"
	common "github.com/grafana/grafana/pkg/apimachinery/apis/common/v0alpha1"
	"github.com/grafana/grafana/pkg/apimachinery/utils"
	dashsvc "github.com/grafana/grafana/pkg/services/dashboards/service"
	"github.com/grafana/grafana/pkg/services/folder"
)

func TestDashboardAPIBuilder_validateUpdateFolder(t *testing.T) {
	tests := []struct {
		name          string
		currentFolder string
		updatedFolder string
		omitFolder    bool
		dryRun        bool
		wantError     bool
	}{
		{
			name:          "reject omitted folder",
			currentFolder: "team-dashboards",
			omitFolder:    true,
			wantError:     true,
		},
		{
			name:          "reject empty folder",
			currentFolder: "team-dashboards",
			wantError:     true,
		},
		{
			name:          "reject omitted folder during dry run",
			currentFolder: "team-dashboards",
			omitFolder:    true,
			dryRun:        true,
			wantError:     true,
		},
		{
			name:          "reject empty folder during dry run",
			currentFolder: "team-dashboards",
			dryRun:        true,
			wantError:     true,
		},
		{
			name:          "reject General folder UID during dry run",
			currentFolder: "team-dashboards",
			updatedFolder: folder.GeneralFolderUID,
			dryRun:        true,
			wantError:     true,
		},
		{
			name:          "allow edit in named folder",
			currentFolder: "team-dashboards",
			updatedFolder: "team-dashboards",
		},
		{
			name:       "allow edit in General without folder annotation",
			omitFolder: true,
		},
		{
			name: "allow edit in General with empty folder annotation",
		},
		{
			name:          "allow edit with General folder UID",
			currentFolder: folder.GeneralFolderUID,
			updatedFolder: folder.GeneralFolderUID,
		},
		{
			name:          "allow General folder UID to empty folder",
			currentFolder: folder.GeneralFolderUID,
		},
		{
			name:          "allow General folder UID to omitted folder",
			currentFolder: folder.GeneralFolderUID,
			omitFolder:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			current := &dashv1.Dashboard{
				TypeMeta: dashv1.DashboardResourceInfo.TypeMeta(),
				ObjectMeta: metav1.ObjectMeta{
					Name:      "folder-validation",
					Namespace: "default",
					Annotations: map[string]string{
						utils.AnnoKeyFolder: tt.currentFolder,
					},
				},
				Spec: common.Unstructured{Object: map[string]any{
					"title":   "Dashboard folder validation",
					"refresh": "10s",
				}},
			}
			updated := current.DeepCopy()
			updated.Spec.Object["title"] = "Dashboard folder validation edit"
			if tt.omitFolder {
				delete(updated.Annotations, utils.AnnoKeyFolder)
			} else {
				updated.Annotations[utils.AnnoKeyFolder] = tt.updatedFolder
			}

			builder := &DashboardsAPIBuilder{
				dashboardService:   &dashsvc.DashboardServiceImpl{},
				minRefreshInterval: "5s",
			}
			err := builder.validateUpdate(context.Background(), admission.NewAttributesRecord(
				updated,
				current,
				dashv1.DashboardResourceInfo.GroupVersionKind(),
				current.Namespace,
				current.Name,
				dashv1.DashboardResourceInfo.GroupVersionResource(),
				"",
				admission.Update,
				&metav1.UpdateOptions{},
				tt.dryRun,
				nil,
			), nil)
			if tt.wantError {
				require.True(t, apierrors.IsBadRequest(err), "expected a bad request, got %v", err)
				require.ErrorContains(t, err, "General")
				return
			}
			require.NoError(t, err)
		})
	}
}
