package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/grafana/grafana/pkg/apimachinery/utils"
	"github.com/grafana/grafana/pkg/services/folder"
	"github.com/grafana/grafana/pkg/tests/apis"
)

func runDashboardFolderAccessTests(t *testing.T, ctx TestContext) {
	t.Helper()

	folderUID := createDashboardAccessFolder(t, ctx, "Shared dashboards")
	adminClient := getResourceClient(t, ctx.Helper, ctx.AdminUser, getDashboardGVR())
	editorClient := getResourceClient(t, ctx.Helper, ctx.EditorUser, getDashboardGVR())

	t.Run("reject removing inherited folder access", func(t *testing.T) {
		dashboard := createDashboardWithInheritedAccess(t, ctx, folderUID)
		for _, endpoint := range []string{"save", "import", "PUT", "PATCH"} {
			for _, destination := range []struct {
				name string
				uid  any
			}{
				{name: "removed", uid: nil},
				{name: "empty", uid: ""},
				{name: "general", uid: folder.GeneralFolderUID},
			} {
				dryRuns := []bool{false}
				if endpoint == "PUT" || endpoint == "PATCH" {
					dryRuns = append(dryRuns, true)
				}
				for _, dryRun := range dryRuns {
					t.Run(fmt.Sprintf("%s/%s/dryRun=%t", endpoint, destination.name, dryRun), func(t *testing.T) {
						request := dashboardFolderRemovalRequest(t, ctx, dashboard, endpoint, destination.uid, dryRun)
						response := apis.DoRequest(ctx.Helper, request, &struct{}{})
						require.Equal(t, http.StatusBadRequest, response.Response.StatusCode, string(response.Body))
						require.Contains(t, string(response.Body), "inherited folder permissions")

						persisted, err := adminClient.Resource.Get(context.Background(), dashboard.GetName(), metav1.GetOptions{})
						require.NoError(t, err)
						require.Equal(t, dashboard.Object, persisted.Object)
						requireDashboardReaders(t, ctx, dashboard.GetName())
					})
				}
			}
		}
	})

	t.Run("preserve folder on a title-only patch", func(t *testing.T) {
		dashboard := createDashboardWithInheritedAccess(t, ctx, folderUID)
		response := apis.DoRequest(ctx.Helper, apis.RequestParams{
			User:        ctx.EditorUser,
			Method:      http.MethodPatch,
			Path:        fmt.Sprintf("/apis/dashboard.grafana.app/v1beta1/namespaces/%s/dashboards/%s", ctx.Helper.Namespacer(ctx.OrgID), dashboard.GetName()),
			ContentType: "application/merge-patch+json",
			Body:        []byte(`{"spec":{"title":"Edited dashboard"}}`),
		}, &unstructured.Unstructured{})
		require.Equal(t, http.StatusOK, response.Response.StatusCode, string(response.Body))
		persisted, err := adminClient.Resource.Get(context.Background(), dashboard.GetName(), metav1.GetOptions{})
		require.NoError(t, err)
		meta, err := utils.MetaAccessor(persisted)
		require.NoError(t, err)
		require.Equal(t, folderUID, meta.GetFolder())
		require.Equal(t, "Edited dashboard", meta.FindTitle(""))
		require.Greater(t, persisted.GetGeneration(), dashboard.GetGeneration())
		require.NotEqual(t, dashboard.GetResourceVersion(), persisted.GetResourceVersion())
		requireDashboardReaders(t, ctx, dashboard.GetName())
	})

	t.Run("allow moving between authorized folders", func(t *testing.T) {
		destinationUID := createDashboardAccessFolder(t, ctx, "Destination dashboards")
		dashboard := createDashboardWithInheritedAccess(t, ctx, folderUID)
		meta, err := utils.MetaAccessor(dashboard)
		require.NoError(t, err)
		meta.SetFolder(destinationUID)
		_, err = editorClient.Resource.Update(context.Background(), dashboard, metav1.UpdateOptions{})
		require.NoError(t, err)
		persisted, err := adminClient.Resource.Get(context.Background(), dashboard.GetName(), metav1.GetOptions{})
		require.NoError(t, err)
		meta, err = utils.MetaAccessor(persisted)
		require.NoError(t, err)
		require.Equal(t, destinationUID, meta.GetFolder())
		requireDashboardReaders(t, ctx, dashboard.GetName())
	})
}

func dashboardFolderRemovalRequest(t *testing.T, ctx TestContext, dashboard *unstructured.Unstructured, endpoint string, destinationUID any, dryRun bool) apis.RequestParams {
	t.Helper()
	request := apis.RequestParams{User: ctx.EditorUser}
	var payload map[string]any

	switch endpoint {
	case "save", "import":
		response := apis.DoRequest(ctx.Helper, apis.RequestParams{
			User: ctx.EditorUser,
			Path: "/api/dashboards/uid/" + dashboard.GetName(),
		}, &struct {
			Dashboard map[string]any `json:"dashboard"`
		}{})
		require.Equal(t, http.StatusOK, response.Response.StatusCode, string(response.Body))
		response.Result.Dashboard["title"] = "Attempted folder removal"
		payload = map[string]any{"dashboard": response.Result.Dashboard, "overwrite": true}
		if destinationUID != nil {
			payload["folderUid"] = destinationUID
		}
		request.Method = http.MethodPost
		request.Path = "/api/dashboards/db"
		if endpoint == "import" {
			delete(response.Result.Dashboard, "id")
			payload["inputs"] = []any{}
			request.Path = "/api/dashboards/import"
		}
	case "PUT", "PATCH":
		request.Method = endpoint
		request.Path = fmt.Sprintf("/apis/dashboard.grafana.app/v1beta1/namespaces/%s/dashboards/%s",
			ctx.Helper.Namespacer(ctx.OrgID), dashboard.GetName())
		if dryRun {
			request.Path += "?dryRun=All"
		}
		if endpoint == "PATCH" {
			request.ContentType = "application/merge-patch+json"
			payload = map[string]any{
				"metadata": map[string]any{"annotations": map[string]any{utils.AnnoKeyFolder: destinationUID}},
				"spec":     map[string]any{"title": "Attempted folder removal"},
			}
			break
		}
		update := dashboard.DeepCopy()
		annotations := update.GetAnnotations()
		if destinationUID == nil {
			delete(annotations, utils.AnnoKeyFolder)
		} else {
			annotations[utils.AnnoKeyFolder] = destinationUID.(string)
		}
		update.SetAnnotations(annotations)
		require.NoError(t, unstructured.SetNestedField(update.Object, "Attempted folder removal", "spec", "title"))
		payload = update.Object
	}

	body, err := json.Marshal(payload)
	require.NoError(t, err)
	request.Body = body
	return request
}

func createDashboardAccessFolder(t *testing.T, ctx TestContext, title string) string {
	t.Helper()
	folder, err := createFolder(t, ctx.Helper, ctx.AdminUser, title)
	require.NoError(t, err)
	require.NotEmpty(t, folder.UID)
	permissions := []ResourcePermissionSetting{}
	permissions = addUserPermission(t, &permissions, ctx.EditorUser, ResourcePermissionLevelEdit)
	permissions = addUserPermission(t, &permissions, ctx.ViewerUser, ResourcePermissionLevelView)
	setResourceUserPermission(t, ctx, ctx.AdminUser, false, folder.UID, permissions)
	t.Cleanup(func() {
		client := getResourceClient(t, ctx.Helper, ctx.AdminUser, getFolderGVR())
		require.NoError(t, client.Resource.Delete(context.Background(), folder.UID, metav1.DeleteOptions{}))
	})
	return folder.UID
}

func createDashboardWithInheritedAccess(t *testing.T, ctx TestContext, folderUID string) *unstructured.Unstructured {
	t.Helper()
	client := getResourceClient(t, ctx.Helper, ctx.AdminUser, getDashboardGVR())
	dashboard, err := createDashboard(t, client, "Dashboard with inherited access", &folderUID, nil, ctx.Helper)
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, client.Resource.Delete(context.Background(), dashboard.GetName(), metav1.DeleteOptions{}))
	})
	permissions := []ResourcePermissionSetting{}
	permissions = addUserPermission(t, &permissions, ctx.AdminUser, ResourcePermissionLevelAdmin)
	setResourceUserPermission(t, ctx, ctx.AdminUser, true, dashboard.GetName(), permissions)
	dashboard, err = client.Resource.Get(context.Background(), dashboard.GetName(), metav1.GetOptions{})
	require.NoError(t, err)
	meta, err := utils.MetaAccessor(dashboard)
	require.NoError(t, err)
	require.Equal(t, folderUID, meta.GetFolder())
	requireDashboardReaders(t, ctx, dashboard.GetName())
	return dashboard
}

func requireDashboardReaders(t *testing.T, ctx TestContext, uid string) {
	t.Helper()
	for _, user := range []apis.User{ctx.EditorUser, ctx.ViewerUser} {
		response := apis.DoRequest(ctx.Helper, apis.RequestParams{
			User: user,
			Path: "/api/dashboards/uid/" + uid,
		}, &struct{}{})
		require.Equal(t, http.StatusOK, response.Response.StatusCode, string(response.Body))
	}
}
