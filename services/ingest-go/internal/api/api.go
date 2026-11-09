// Package api exposes the ingest service's HTTP surface: health, metrics and
// read-only device/reading queries.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/store"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

type Reader interface {
	Ping(ctx context.Context) error
	ListDevices(ctx context.Context) ([]store.Device, error)
	Readings(ctx context.Context, deviceID string, since int64, limit int) ([]telemetry.Reading, error)
}

type QueueDepth interface{ Depth() int }

const (
	defaultLimit = 300
	maxLimit     = 5000
	// Readiness fails when the queue is this full: a load balancer should
	// stop sending new device connections to an instance that is falling behind.
	readyQueueThreshold = 0.9
)

func Handler(r Reader, q QueueDepth, queueCap int, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), time.Second)
		defer cancel()
		if err := r.Ping(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "store_unavailable"})
			return
		}
		if float64(q.Depth()) >= readyQueueThreshold*float64(queueCap) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "overloaded"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	mux.Handle("GET /metrics", promhttp.Handler())

	mux.HandleFunc("GET /api/v1/devices", func(w http.ResponseWriter, req *http.Request) {
		devs, err := r.ListDevices(req.Context())
		if err != nil {
			log.Error("list devices", "err", err)
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"devices": devs})
	})

	mux.HandleFunc("GET /api/v1/devices/{id}/readings", func(w http.ResponseWriter, req *http.Request) {
		id := req.PathValue("id")
		if !telemetry.ValidDeviceID(id) {
			writeError(w, http.StatusBadRequest, "invalid_device_id")
			return
		}
		since, err := intParam(req, "since", 0)
		if err != nil || since < 0 {
			writeError(w, http.StatusBadRequest, "invalid_since")
			return
		}
		limit, err := intParam(req, "limit", defaultLimit)
		if err != nil || limit < 1 || limit > maxLimit {
			writeError(w, http.StatusBadRequest, "invalid_limit")
			return
		}
		rs, err := r.Readings(req.Context(), id, since, int(limit))
		if err != nil {
			log.Error("query readings", "device", id, "err", err)
			writeError(w, http.StatusInternalServerError, "internal_error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deviceId": id, "readings": rs})
	})

	return mux
}

func intParam(req *http.Request, name string, def int64) (int64, error) {
	v := req.URL.Query().Get(name)
	if v == "" {
		return def, nil
	}
	return strconv.ParseInt(v, 10, 64)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
