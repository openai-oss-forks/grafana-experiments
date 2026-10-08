package database

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana/pkg/components/simplejson"
	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/services/dashboards"
	dashver "github.com/grafana/grafana/pkg/services/dashboardversion"
	"github.com/grafana/grafana/pkg/services/tag/tagimpl"
	"github.com/grafana/grafana/pkg/util/testutil"
)

func TestIntegrationDashboardCompetingCreate(t *testing.T) {
	testutil.SkipIntegrationTestInShortMode(t)

	sqlStore, cfg := db.InitTestDBWithCfg(t)
	service, err := ProvideDashboardStore(sqlStore, cfg, testFeatureToggles, tagimpl.ProvideService(sqlStore))
	require.NoError(t, err)
	store := service.(*dashboardStore)
	ctx := context.Background()
	const uid = "competing-create"
	expectedVersion := int64(0)
	winnerCommand := dashboards.SaveDashboardCommand{
		OrgID:           1,
		Overwrite:       true,
		ExpectedVersion: &expectedVersion,
		Dashboard: simplejson.NewFromAny(map[string]any{
			"uid": uid, "title": "Winner", "tags": []any{"winner"},
		}),
	}
	loserCommand := dashboards.SaveDashboardCommand{
		OrgID:           1,
		Overwrite:       true,
		ExpectedVersion: &expectedVersion,
		Dashboard: simplejson.NewFromAny(map[string]any{
			"uid": uid, "title": "Loser", "tags": []any{"loser"},
		}),
	}
	provisioning := &dashboards.DashboardProvisioning{
		Name:       "test-provider",
		ExternalID: "winner.json",
		CheckSum:   "winner-checksum",
		Updated:    1000,
	}

	type dashboardState struct {
		dashboards   []dashboards.Dashboard
		versions     []dashver.DashboardVersion
		tags         []dashboardTag
		provisioning []dashboards.DashboardProvisioning
	}
	var winner *dashboards.Dashboard
	readState := func() dashboardState {
		t.Helper()
		var state dashboardState
		require.NoError(t, sqlStore.WithDbSession(ctx, func(sess *db.Session) error {
			if err := sess.Where("org_id = ? AND uid = ?", 1, uid).Find(&state.dashboards); err != nil {
				return err
			}
			if err := sess.Where("dashboard_id = ?", winner.ID).Asc("version").Find(&state.versions); err != nil {
				return err
			}
			if err := sess.Where("org_id = ? AND dashboard_uid = ?", 1, uid).Asc("term").Find(&state.tags); err != nil {
				return err
			}
			return sess.Where("dashboard_id = ?", winner.ID).Asc("id").Find(&state.provisioning)
		}))
		return state
	}

	var committed dashboardState
	err = sqlStore.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		// Validation uses a separate transaction because ctx contains no SQL session.
		// Commit the winner after the absence check and before the losing INSERT.
		sess.Before(func(any) {
			var err error
			winner, err = service.SaveProvisionedDashboard(ctx, winnerCommand, provisioning)
			require.NoError(t, err)
			require.NotNil(t, winner)
			committed = readState()
		})
		_, err := store.saveDashboard(ctx, sess, &loserCommand, store.emitEntityEvent())
		return err
	})
	require.ErrorIs(t, err, dashboards.ErrDashboardWithSameUIDExists)
	require.Len(t, committed.dashboards, 1)
	require.Equal(t, "Winner", committed.dashboards[0].Title)
	require.Equal(t, 1, committed.dashboards[0].Version)
	require.Len(t, committed.versions, 1)
	require.Equal(t, 1, committed.versions[0].Version)
	require.Equal(t, "Winner", committed.versions[0].Data.Get("title").MustString())
	require.Len(t, committed.tags, 1)
	require.Equal(t, "winner", committed.tags[0].Term)
	require.Equal(t, []dashboards.DashboardProvisioning{*provisioning}, committed.provisioning)
	require.Equal(t, committed, readState())
}
