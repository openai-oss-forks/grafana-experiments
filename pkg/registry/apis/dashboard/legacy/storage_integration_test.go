package legacy

import (
	"context"
	"encoding/json"
	"testing"

	claims "github.com/grafana/authlib/types"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	dashboardV0 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v0alpha1"
	dashboardV1 "github.com/grafana/grafana/apps/dashboard/pkg/apis/dashboard/v1beta1"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/apimachinery/utils"
	"github.com/grafana/grafana/pkg/components/simplejson"
	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/dashboards"
	"github.com/grafana/grafana/pkg/services/dashboards/database"
	dashver "github.com/grafana/grafana/pkg/services/dashboardversion"
	"github.com/grafana/grafana/pkg/services/featuremgmt"
	"github.com/grafana/grafana/pkg/services/libraryelements"
	"github.com/grafana/grafana/pkg/services/librarypanels"
	"github.com/grafana/grafana/pkg/services/tag/tagimpl"
	"github.com/grafana/grafana/pkg/services/user"
	"github.com/grafana/grafana/pkg/storage/legacysql"
	"github.com/grafana/grafana/pkg/storage/unified/resource"
	"github.com/grafana/grafana/pkg/storage/unified/resourcepb"
	"github.com/grafana/grafana/pkg/tests/testsuite"
	"github.com/grafana/grafana/pkg/util/testutil"
)

func TestMain(m *testing.M) {
	testsuite.Run(m)
}

func TestIntegrationDashboardWriteEventVersion(t *testing.T) {
	testutil.SkipIntegrationTestInShortMode(t)

	for _, provisioned := range []bool{false, true} {
		name := "dashboard"
		if provisioned {
			name = "provisioned dashboard"
		}
		t.Run(name, func(t *testing.T) {
			sqlStore, cfg := db.InitTestDBWithCfg(t)
			store, err := database.ProvideDashboardStore(sqlStore, cfg, featuremgmt.WithFeatures(), tagimpl.ProvideService(sqlStore))
			require.NoError(t, err)
			access := &dashboardSqlAccess{
				sql:        legacysql.NewDatabaseProvider(sqlStore),
				namespacer: claims.OrgNamespaceFormatter,
				dashStore:  store,
				libraryPanelSvc: &librarypanels.LibraryPanelService{
					LibraryElementService: &libraryelements.LibraryElementService{SQLStore: sqlStore},
				},
				log: log.New("test.dashboard.sql"),
			}
			ctx := identity.WithRequester(context.Background(), &user.SignedInUser{UserID: 1, OrgID: 1})
			folder, err := store.SaveDashboard(ctx, dashboards.SaveDashboardCommand{
				OrgID:    1,
				IsFolder: true,
				Dashboard: simplejson.NewFromAny(map[string]any{
					"uid": "committed-folder", "title": "Committed folder",
				}),
			})
			require.NoError(t, err)

			initial := &dashboardV1.Dashboard{
				TypeMeta: dashboardV0.DashboardResourceInfo.TypeMeta(),
				ObjectMeta: metav1.ObjectMeta{
					Name: "versioned-dashboard", Namespace: claims.OrgNamespaceFormatter(1),
				},
				Spec: *dashboardV0.NewDashboardSpec(),
			}
			initial.Spec.Set("title", "Initial dashboard")
			initial.Spec.Set("panels", []any{})
			if provisioned {
				meta, err := utils.MetaAccessor(initial)
				require.NoError(t, err)
				meta.SetManagerProperties(utils.ManagerProperties{
					Kind:     utils.ManagerKindClassicFP, //nolint:staticcheck
					Identity: "test-provider",
				})
				meta.SetSourceProperties(utils.SourceProperties{Path: "dashboard.json", Checksum: "initial", TimestampMillis: 1000})
			}
			pending := initial.DeepCopy()
			pending.Spec.Set("title", "Pending create")
			pendingCommand, err := access.buildSaveDashboardCommand(ctx, 1, pending, 0)
			require.NoError(t, err)
			pendingProvisioning, err := getProvisioningDataFromEvent(dashboardWriteEvent(t, pending, resourcepb.WatchEvent_ADDED, 0))
			require.NoError(t, err)
			version, err := access.WriteEvent(ctx, dashboardWriteEvent(t, initial, resourcepb.WatchEvent_ADDED, 0))
			require.NoError(t, err)
			require.Equal(t, int64(1), version)
			created, err := store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			initialMeta, err := utils.MetaAccessor(initial)
			require.NoError(t, err)
			initialMeta.SetDeprecatedInternalID(created.ID) //nolint:staticcheck

			moved := initial.DeepCopy()
			moved.Spec.Set("title", "Committed dashboard")
			moved.Spec.Set("tags", []any{"committed"})
			meta, err := utils.MetaAccessor(moved)
			require.NoError(t, err)
			meta.SetFolder(folder.UID)
			meta.SetMessage("Move to folder")
			if provisioned {
				meta.SetSourceProperties(utils.SourceProperties{Path: "dashboard.json", Checksum: "committed", TimestampMillis: 2000})
			}
			version, err = access.WriteEvent(ctx, dashboardWriteEvent(t, moved, resourcepb.WatchEvent_MODIFIED, version))
			require.NoError(t, err)
			require.Equal(t, int64(2), version)
			committed, err := store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			history := dashboardHistory(t, ctx, sqlStore, committed.ID)
			require.Len(t, history, 2)

			// The create command was prepared while the UID did not exist.
			if provisioned {
				require.NotNil(t, pendingProvisioning)
				_, err = store.SaveProvisionedDashboard(ctx, *pendingCommand, pendingProvisioning)
			} else {
				_, err = store.SaveDashboard(ctx, *pendingCommand)
			}
			require.ErrorIs(t, err, dashboards.ErrDashboardWithSameUIDExists)
			afterPendingCreate, err := store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			require.Equal(t, committed, afterPendingCreate)
			require.Equal(t, history, dashboardHistory(t, ctx, sqlStore, committed.ID))

			// This write was admitted before the folder move committed.
			stale := initial.DeepCopy()
			stale.Spec.Set("title", "Stale dashboard")
			stale.Spec.Set("tags", []any{"stale"})
			_, err = access.WriteEvent(ctx, dashboardWriteEvent(t, stale, resourcepb.WatchEvent_MODIFIED, 1))
			require.True(t, apierrors.IsConflict(err), "expected a conflict, got %v", err)
			persisted, err := store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			require.Equal(t, committed, persisted)
			require.Equal(t, history, dashboardHistory(t, ctx, sqlStore, committed.ID))
			if provisioned {
				provisioning, err := store.GetProvisionedDataByDashboardID(ctx, committed.ID)
				require.NoError(t, err)
				require.Equal(t, "committed", provisioning.CheckSum)
			}
			_, err = access.WriteEvent(ctx, dashboardWriteEvent(t, stale, resourcepb.WatchEvent_MODIFIED, 0))
			require.True(t, apierrors.IsBadRequest(err), "expected a missing-version error, got %v", err)
			require.Equal(t, history, dashboardHistory(t, ctx, sqlStore, committed.ID))
			missingID := moved.DeepCopy()
			meta, err = utils.MetaAccessor(missingID)
			require.NoError(t, err)
			meta.SetDeprecatedInternalID(0) //nolint:staticcheck
			_, err = access.WriteEvent(ctx, dashboardWriteEvent(t, missingID, resourcepb.WatchEvent_MODIFIED, version))
			require.True(t, apierrors.IsBadRequest(err), "expected a missing-ID error, got %v", err)
			require.Equal(t, history, dashboardHistory(t, ctx, sqlStore, committed.ID))

			fresh := moved.DeepCopy()
			fresh.Spec.Set("title", "Fresh dashboard")
			version, err = access.WriteEvent(ctx, dashboardWriteEvent(t, fresh, resourcepb.WatchEvent_MODIFIED, version))
			require.NoError(t, err)
			require.Equal(t, int64(3), version)
			persisted, err = store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			require.Equal(t, folder.UID, persisted.FolderUID)
			require.Equal(t, "Fresh dashboard", persisted.Title)
			updatedHistory := dashboardHistory(t, ctx, sqlStore, committed.ID)
			require.Len(t, updatedHistory, 3)
			require.Equal(t, history, updatedHistory[:2])
			require.Equal(t, 2, updatedHistory[2].ParentVersion)
			require.Equal(t, "Fresh dashboard", updatedHistory[2].Data.Get("title").MustString())

			require.NoError(t, store.DeleteDashboard(ctx, &dashboards.DeleteDashboardCommand{OrgID: 1, UID: initial.Name}))
			_, err = access.WriteEvent(ctx, dashboardWriteEvent(t, fresh, resourcepb.WatchEvent_MODIFIED, version))
			require.True(t, apierrors.IsConflict(err), "expected a conflict after deletion, got %v", err)
			_, err = store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.ErrorIs(t, err, dashboards.ErrDashboardNotFound)
			require.Empty(t, dashboardHistory(t, ctx, sqlStore, committed.ID))

			replacement := initial.DeepCopy()
			replacement.Spec.Set("title", "Replacement dashboard")
			replacement.Spec.Set("tags", []any{"replacement"})
			meta, err = utils.MetaAccessor(replacement)
			require.NoError(t, err)
			meta.SetDeprecatedInternalID(0) //nolint:staticcheck
			meta.SetFolder(folder.UID)
			if provisioned {
				meta.SetSourceProperties(utils.SourceProperties{Path: "dashboard.json", Checksum: "replacement", TimestampMillis: 3000})
			}
			version, err = access.WriteEvent(ctx, dashboardWriteEvent(t, replacement, resourcepb.WatchEvent_ADDED, 0))
			require.NoError(t, err)
			require.Equal(t, int64(1), version)
			recreated, err := store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			require.NotEqual(t, committed.ID, recreated.ID)
			require.Equal(t, folder.UID, recreated.FolderUID)
			replacementHistory := dashboardHistory(t, ctx, sqlStore, recreated.ID)
			require.Len(t, replacementHistory, 1)
			var replacementProvisioning *dashboards.DashboardProvisioningSearchResults
			if provisioned {
				replacementProvisioning, err = store.GetProvisionedDataByDashboardID(ctx, recreated.ID)
				require.NoError(t, err)
				require.NotNil(t, replacementProvisioning)
			}

			// The replacement can commit before or after the resource server reads the current object.
			meta.SetDeprecatedInternalID(recreated.ID) //nolint:staticcheck
			for _, previous := range []utils.GrafanaMetaAccessor{initialMeta, meta} {
				event := dashboardWriteEvent(t, stale, resourcepb.WatchEvent_MODIFIED, 1)
				event.ObjectOld = previous
				_, err = access.WriteEvent(ctx, event)
				require.True(t, apierrors.IsConflict(err), "expected a conflict after replacement, got %v", err)
			}
			persisted, err = store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			require.Equal(t, recreated, persisted)
			require.Equal(t, replacementHistory, dashboardHistory(t, ctx, sqlStore, recreated.ID))
			require.Empty(t, dashboardHistory(t, ctx, sqlStore, committed.ID))
			if provisioned {
				provisioning, err := store.GetProvisionedDataByDashboardID(ctx, recreated.ID)
				require.NoError(t, err)
				require.Equal(t, replacementProvisioning, provisioning)
			}

			duplicate := initial.DeepCopy()
			duplicate.Spec.Set("title", "Duplicate dashboard")
			duplicate.Spec.Set("id", recreated.ID)
			duplicate.Spec.Set("version", float64(recreated.Version))
			_, err = access.WriteEvent(ctx, dashboardWriteEvent(t, duplicate, resourcepb.WatchEvent_ADDED, 0))
			require.True(t, apierrors.IsAlreadyExists(err), "expected a duplicate error, got %v", err)
			persisted, err = store.GetDashboard(ctx, &dashboards.GetDashboardQuery{OrgID: 1, UID: initial.Name})
			require.NoError(t, err)
			require.Equal(t, recreated, persisted)
			require.Equal(t, replacementHistory, dashboardHistory(t, ctx, sqlStore, recreated.ID))
			if provisioned {
				provisioning, err := store.GetProvisionedDataByDashboardID(ctx, recreated.ID)
				require.NoError(t, err)
				require.Equal(t, replacementProvisioning, provisioning)
			}
			_, err = access.WriteEvent(ctx, dashboardWriteEvent(t, duplicate, resourcepb.WatchEvent_ADDED, 1))
			require.True(t, apierrors.IsBadRequest(err), "expected a nonzero-version create error, got %v", err)
		})
	}
}

func dashboardWriteEvent(t *testing.T, dashboard *dashboardV1.Dashboard, eventType resourcepb.WatchEvent_Type, version int64) resource.WriteEvent {
	t.Helper()
	copy := dashboard.DeepCopy()
	meta, err := utils.MetaAccessor(copy)
	require.NoError(t, err)
	value, err := json.Marshal(copy)
	require.NoError(t, err)
	return resource.WriteEvent{
		Type: eventType,
		Key: &resourcepb.ResourceKey{
			Namespace: dashboard.Namespace,
			Group:     dashboardV1.DashboardResourceInfo.GroupResource().Group,
			Resource:  dashboardV1.DashboardResourceInfo.GroupResource().Resource,
			Name:      dashboard.Name,
		},
		PreviousRV: version,
		Value:      value,
		Object:     meta,
	}
}

func dashboardHistory(t *testing.T, ctx context.Context, sqlStore db.DB, dashboardID int64) []dashver.DashboardVersion {
	t.Helper()
	var versions []dashver.DashboardVersion
	require.NoError(t, sqlStore.WithDbSession(ctx, func(sess *db.Session) error {
		return sess.Where("dashboard_id = ?", dashboardID).Asc("version").Find(&versions)
	}))
	return versions
}
