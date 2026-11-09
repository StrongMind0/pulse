// Package store persists readings and device state in SQLite.
//
// SQLite (pure Go driver, no cgo) keeps Phase 1 runnable with zero external
// services. The Store interface is narrow so a Postgres/Timescale
// implementation can replace it without touching the pipeline.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
	_ "modernc.org/sqlite"
)

// Device is the read model for a device.
type Device struct {
	ID           string `json:"id"`
	FirstSeen    int64  `json:"firstSeen"`
	LastSeen     int64  `json:"lastSeen"`
	LastSeq      int64  `json:"lastSeq"`
	Online       bool   `json:"online"`
	ReadingCount int64  `json:"readingCount"`
}

type SQLite struct{ db *sql.DB }

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS readings (
  device_id   TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  clock_skew  INTEGER NOT NULL DEFAULT 0,
  metrics     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_device_ts ON readings (device_id, ts);
CREATE INDEX IF NOT EXISTS readings_received ON readings (received_at);
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  last_seq      INTEGER NOT NULL,
  online        INTEGER NOT NULL DEFAULT 0,
  reading_count INTEGER NOT NULL DEFAULT 0
);`

// Open opens (and migrates) the database at path. Use ":memory:" in tests.
func Open(path string) (*SQLite, error) {
	dsn := path
	if path == ":memory:" {
		// A shared in-memory database must be pinned to one connection or each
		// connection would see its own empty database.
		dsn = "file::memory:?cache=shared"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite allows one writer at a time; a single connection avoids
	// SQLITE_BUSY churn and the pipeline already batches writes.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &SQLite{db: db}, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// InsertBatch writes readings and updates device rows in one transaction, so
// a crash never leaves the device table ahead of the readings table.
func (s *SQLite) InsertBatch(ctx context.Context, batch []telemetry.Reading) error {
	if len(batch) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after commit

	ins, err := tx.PrepareContext(ctx,
		`INSERT INTO readings (device_id, seq, ts, received_at, clock_skew, metrics) VALUES (?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer ins.Close()
	upd, err := tx.PrepareContext(ctx, `
INSERT INTO devices (id, first_seen, last_seen, last_seq, online, reading_count)
VALUES (?, ?, ?, ?, 1, 1)
ON CONFLICT(id) DO UPDATE SET
  last_seen = MAX(last_seen, excluded.last_seen),
  last_seq = excluded.last_seq,
  reading_count = reading_count + 1`)
	if err != nil {
		return err
	}
	defer upd.Close()

	for _, r := range batch {
		m, err := json.Marshal(r.Metrics)
		if err != nil {
			return err
		}
		if _, err := ins.ExecContext(ctx, r.DeviceID, r.Seq, r.TS, r.ReceivedAt, boolInt(r.ClockSkew), string(m)); err != nil {
			return err
		}
		if _, err := upd.ExecContext(ctx, r.DeviceID, r.ReceivedAt, r.ReceivedAt, r.Seq); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetOnline records a connect/disconnect. Unknown devices are created so a
// device that connects but never publishes is still visible.
func (s *SQLite) SetOnline(ctx context.Context, id string, online bool, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO devices (id, first_seen, last_seen, last_seq, online) VALUES (?, ?, ?, -1, ?)
ON CONFLICT(id) DO UPDATE SET online = excluded.online, last_seen = MAX(last_seen, excluded.last_seen)`,
		id, at.UnixMilli(), at.UnixMilli(), boolInt(online))
	return err
}

// MarkAllOffline is called at startup: any device flagged online belonged to
// a previous process whose connections are gone.
func (s *SQLite) MarkAllOffline(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET online = 0`)
	return err
}

func (s *SQLite) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, first_seen, last_seen, last_seq, online, reading_count FROM devices ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var d Device
		var online int
		if err := rows.Scan(&d.ID, &d.FirstSeen, &d.LastSeen, &d.LastSeq, &online, &d.ReadingCount); err != nil {
			return nil, err
		}
		d.Online = online == 1
		out = append(out, d)
	}
	return out, rows.Err()
}

// LastSeqs seeds the in-memory duplicate filter after a restart.
func (s *SQLite) LastSeqs(ctx context.Context) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, last_seq FROM devices WHERE last_seq >= 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var seq int64
		if err := rows.Scan(&id, &seq); err != nil {
			return nil, err
		}
		out[id] = seq
	}
	return out, rows.Err()
}

// Readings returns up to limit readings for a device with ts >= since, oldest first.
func (s *SQLite) Readings(ctx context.Context, deviceID string, since int64, limit int) ([]telemetry.Reading, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT seq, ts, received_at, clock_skew, metrics FROM (
  SELECT seq, ts, received_at, clock_skew, metrics FROM readings
  WHERE device_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?
) ORDER BY ts ASC`, deviceID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []telemetry.Reading{}
	for rows.Next() {
		r := telemetry.Reading{DeviceID: deviceID}
		var skew int
		var m string
		if err := rows.Scan(&r.Seq, &r.TS, &r.ReceivedAt, &skew, &m); err != nil {
			return nil, err
		}
		r.ClockSkew = skew == 1
		if err := json.Unmarshal([]byte(m), &r.Metrics); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Prune deletes readings received before cutoff. Unbounded retention is the
// most common way a telemetry system quietly runs out of disk.
func (s *SQLite) Prune(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM readings WHERE received_at < ?`, cutoff.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
