// Package metrics declares every Prometheus series the ingest service exports.
// Keeping them in one place makes the operational surface easy to review.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	Received = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pulse_ingest_messages_received_total",
		Help: "Telemetry messages received from devices, before validation.",
	})
	Rejected = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pulse_ingest_messages_rejected_total",
		Help: "Telemetry messages rejected, by reason.",
	}, []string{"reason"})
	Dropped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pulse_ingest_readings_dropped_total",
		Help: "Valid readings dropped after acceptance (queue full or store failure).",
	}, []string{"reason"})
	Persisted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pulse_ingest_readings_persisted_total",
		Help: "Readings committed to the store.",
	})
	ClockSkew = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pulse_ingest_clock_skew_total",
		Help: "Readings whose device timestamp was replaced by server time.",
	})
	QueueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "pulse_ingest_queue_depth",
		Help: "Readings waiting to be persisted.",
	})
	BatchSize = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "pulse_ingest_batch_size",
		Help:    "Readings per store write.",
		Buckets: []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000},
	})
	FlushSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "pulse_ingest_flush_seconds",
		Help:    "Store write latency per batch.",
		Buckets: prometheus.ExponentialBuckets(0.0005, 2, 14),
	})
	StoreErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pulse_ingest_store_errors_total",
		Help: "Failed store write attempts (each retry counts).",
	})
	DevicesOnline = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "pulse_ingest_devices_online",
		Help: "Devices with an open MQTT connection.",
	})
	AuthFailures = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pulse_ingest_auth_failures_total",
		Help: "Rejected MQTT connection attempts.",
	})
	ACLDenied = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pulse_ingest_acl_denied_total",
		Help: "Publishes or subscribes denied by topic ACL.",
	})
)
