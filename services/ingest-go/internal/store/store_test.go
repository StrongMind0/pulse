package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

func openTemp(t *testing.T) *SQLite {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "pulse.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func reading(id string, seq, ts int64) telemetry.Reading {
	return telemetry.Reading{DeviceID: id, Seq: seq, TS: ts, ReceivedAt: ts, Metrics: map[string]float64{"temperature_c": float64(seq)}}
}

func TestInsertAndQuery(t *testing.T) {
	ctx := context.Background()
	s := openTemp(t)

	batch := []telemetry.Reading{reading("pump-01", 1, 1000), reading("pump-01", 2, 2000), reading("fan-02", 1, 1500)}
	if err := s.InsertBatch(ctx, batch); err != nil {
		t.Fatal(err)
	}

	got, err := s.Readings(ctx, "pump-01", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Seq != 1 || got[1].Seq != 2 || got[1].Metrics["temperature_c"] != 2 {
		t.Fatalf("unexpected readings %+v", got)
	}

	// limit keeps the newest readings, still returned oldest-first
	got, _ = s.Readings(ctx, "pump-01", 0, 1)
	if len(got) != 1 || got[0].Seq != 2 {
		t.Fatalf("limit should keep newest, got %+v", got)
	}

	devs, err := s.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devs) != 2 || devs[1].ID != "pump-01" || devs[1].ReadingCount != 2 || devs[1].LastSeq != 2 {
		t.Fatalf("unexpected devices %+v", devs)
	}

	seqs, _ := s.LastSeqs(ctx)
	if seqs["pump-01"].Seq != 2 || seqs["fan-02"].Seq != 1 {
		t.Fatalf("unexpected last seqs %v", seqs)
	}
}

func TestOnlineAndPrune(t *testing.T) {
	ctx := context.Background()
	s := openTemp(t)

	if err := s.SetOnline(ctx, "quiet-01", true, time.UnixMilli(500)); err != nil {
		t.Fatal(err)
	}
	devs, _ := s.ListDevices(ctx)
	if len(devs) != 1 || !devs[0].Online || devs[0].LastSeq != -1 {
		t.Fatalf("connect-only device should be listed online, got %+v", devs)
	}
	if err := s.MarkAllOffline(ctx); err != nil {
		t.Fatal(err)
	}
	devs, _ = s.ListDevices(ctx)
	if devs[0].Online {
		t.Fatal("expected offline after MarkAllOffline")
	}

	_ = s.InsertBatch(ctx, []telemetry.Reading{reading("pump-01", 1, 1000), reading("pump-01", 2, 9000)})
	n, err := s.Prune(ctx, time.UnixMilli(5000))
	if err != nil || n != 1 {
		t.Fatalf("prune removed %d rows, err %v", n, err)
	}
}

// A database created before the boot-id migration must upgrade in place and
// keep its data.
func TestMigratesOldDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(schema); err != nil { // schema as it was, no migrations
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO devices (id, first_seen, last_seen, last_seq) VALUES ('pump-01', 1, 1, 405)`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("open old db: %v", err)
	}
	defer s.Close()
	seqs, err := s.LastSeqs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if seqs["pump-01"] != (telemetry.SeqState{Boot: 0, Seq: 405}) {
		t.Fatalf("unexpected state after migration: %+v", seqs)
	}
	// reopening must not try to re-run the migration
	s.Close()
	if s2, err := Open(path); err != nil {
		t.Fatalf("reopen: %v", err)
	} else {
		s2.Close()
	}
}

func TestBootIsPersisted(t *testing.T) {
	ctx := context.Background()
	s := openTemp(t)
	r := reading("pump-01", 7, 1000)
	r.Boot = 0xBEEF
	if err := s.InsertBatch(ctx, []telemetry.Reading{r}); err != nil {
		t.Fatal(err)
	}
	seqs, _ := s.LastSeqs(ctx)
	if seqs["pump-01"] != (telemetry.SeqState{Boot: 0xBEEF, Seq: 7}) {
		t.Fatalf("got %+v", seqs["pump-01"])
	}
}
