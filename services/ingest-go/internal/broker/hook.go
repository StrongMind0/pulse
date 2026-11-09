// Package broker plugs Pulse's auth, topic ACLs and telemetry handling into
// the embedded MQTT broker.
//
// Identity model (Phase 1):
//   - Devices log in with username == client id == device id and the shared
//     device token. A device may only publish to its own telemetry topic and
//     may not subscribe to anything, so one compromised device cannot spoof
//     another or read the fleet's data.
//   - Backend services log in with username "svc:<name>" and the service
//     token. They may read pulse/v1/internal/# and publish alerts, but may
//     never publish device telemetry.
//
// Phase 3 replaces shared tokens with per-device mTLS certificates.
package broker

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/packets"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/metrics"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

const (
	servicePrefix  = "svc:"
	InternalPrefix = "pulse/v1/internal/"
	AlertsTopic    = "pulse/v1/internal/alerts"
	statusTimeout  = 2 * time.Second
)

// Sink receives readings that passed validation and duplicate checks.
type Sink interface {
	Offer(telemetry.Reading) bool
}

// StatusStore records device connectivity.
type StatusStore interface {
	SetOnline(ctx context.Context, id string, online bool, at time.Time) error
}

// Publisher sends a message from the broker itself (inline client).
type Publisher func(topic string, payload []byte, retain bool, qos byte) error

type Config struct {
	DeviceToken  string
	ServiceToken string
}

type StatusEvent struct {
	DeviceID string `json:"deviceId"`
	Online   bool   `json:"online"`
	At       int64  `json:"at"`
}

type Hook struct {
	mqtt.HookBase
	cfg     Config
	sink    Sink
	status  StatusStore
	publish Publisher
	now     func() time.Time
	log     *slog.Logger

	mu      sync.Mutex
	lastSeq map[string]telemetry.SeqState
	conns   map[string]int // open connections per device; >1 during a session takeover
}

func NewHook(cfg Config, sink Sink, status StatusStore, publish Publisher, seed map[string]telemetry.SeqState, log *slog.Logger) *Hook {
	if seed == nil {
		seed = map[string]telemetry.SeqState{}
	}
	return &Hook{cfg: cfg, sink: sink, status: status, publish: publish, now: time.Now, log: log, lastSeq: seed, conns: map[string]int{}}
}

func (h *Hook) ID() string { return "pulse" }

func (h *Hook) Provides(b byte) bool {
	return bytes.Contains([]byte{
		mqtt.OnConnectAuthenticate, mqtt.OnACLCheck, mqtt.OnPublish,
		mqtt.OnSessionEstablished, mqtt.OnDisconnect,
	}, []byte{b})
}

func isService(cl *mqtt.Client) bool {
	return strings.HasPrefix(string(cl.Properties.Username), servicePrefix)
}

func tokenEqual(got []byte, want string) bool {
	return want != "" && subtle.ConstantTimeCompare(got, []byte(want)) == 1
}

// OnConnectAuthenticate decides who may connect at all.
func (h *Hook) OnConnectAuthenticate(cl *mqtt.Client, pk packets.Packet) bool {
	user := string(pk.Connect.Username)
	ok := false
	switch {
	case strings.HasPrefix(user, servicePrefix):
		ok = tokenEqual(pk.Connect.Password, h.cfg.ServiceToken)
	default:
		ok = user == cl.ID && telemetry.ValidDeviceID(user) && tokenEqual(pk.Connect.Password, h.cfg.DeviceToken)
	}
	if !ok {
		metrics.AuthFailures.Inc()
		h.log.Warn("mqtt auth rejected", "client", cl.ID, "user", user, "remote", cl.Net.Remote)
	}
	return ok
}

// OnACLCheck enforces least-privilege topic access.
func (h *Hook) OnACLCheck(cl *mqtt.Client, topic string, write bool) bool {
	var ok bool
	if isService(cl) {
		if write {
			ok = topic == AlertsTopic
		} else {
			ok = strings.HasPrefix(topic, InternalPrefix)
		}
	} else {
		ok = write && topic == telemetry.TelemetryTopic(cl.ID)
	}
	if !ok {
		metrics.ACLDenied.Inc()
	}
	return ok
}

// OnPublish validates device telemetry and hands it to the pipeline.
//
// Raw device messages are never fanned out (CodeSuccessIgnore acknowledges
// and swallows them); consumers only ever see the validated, persisted
// stream on the internal topic.
func (h *Hook) OnPublish(cl *mqtt.Client, pk packets.Packet) (packets.Packet, error) {
	if cl.Net.Inline || isService(cl) {
		return pk, nil
	}
	metrics.Received.Inc()

	r, err := telemetry.Parse(pk.TopicName, pk.Payload, h.now())
	if err != nil {
		metrics.Rejected.WithLabelValues(reason(err)).Inc()
		h.log.Debug("telemetry rejected", "device", cl.ID, "err", err)
		return pk, packets.CodeSuccessIgnore
	}
	if r.DeviceID != cl.ID { // ACL should already prevent this; defence in depth
		metrics.Rejected.WithLabelValues(telemetry.ErrIDMismatch.Error()).Inc()
		return pk, packets.CodeSuccessIgnore
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	last, seen := h.lastSeq[r.DeviceID]
	if telemetry.IsDuplicate(last, seen, r.Boot, r.Seq) {
		metrics.Rejected.WithLabelValues(telemetry.ErrDuplicate.Error()).Inc()
		return pk, packets.CodeSuccessIgnore
	}
	if !h.sink.Offer(r) {
		// Queue full: withhold the PUBACK. A QoS 1 device keeps the message
		// and retransmits, which pushes backpressure to the edge instead of
		// silently losing data. QoS 0 messages are simply shed.
		return pk, packets.ErrRejectPacket
	}
	h.lastSeq[r.DeviceID] = telemetry.SeqState{Boot: r.Boot, Seq: r.Seq}
	if r.ClockSkew {
		metrics.ClockSkew.Inc()
	}
	return pk, packets.CodeSuccessIgnore
}

func (h *Hook) OnSessionEstablished(cl *mqtt.Client, _ packets.Packet) {
	if cl.Net.Inline || isService(cl) {
		return
	}
	h.mu.Lock()
	h.conns[cl.ID]++
	first := h.conns[cl.ID] == 1
	h.mu.Unlock()
	if first {
		metrics.DevicesOnline.Inc()
		h.setStatus(cl.ID, true)
	}
}

// OnDisconnect fires for the old connection when a device reconnects with
// the same client id (session takeover). Counting connections keeps that
// from flashing the device offline.
func (h *Hook) OnDisconnect(cl *mqtt.Client, err error, _ bool) {
	if cl.Net.Inline || isService(cl) {
		return
	}
	h.mu.Lock()
	n, known := h.conns[cl.ID]
	if !known {
		h.mu.Unlock()
		return // auth failed before a session existed
	}
	if n <= 1 {
		delete(h.conns, cl.ID)
	} else {
		h.conns[cl.ID] = n - 1
	}
	last := n <= 1
	h.mu.Unlock()
	if last {
		metrics.DevicesOnline.Dec()
		h.log.Info("device offline", "device", cl.ID, "err", err)
		h.setStatus(cl.ID, false)
	}
}

func (h *Hook) setStatus(id string, online bool) {
	at := h.now()
	ctx, cancel := context.WithTimeout(context.Background(), statusTimeout)
	defer cancel()
	if err := h.status.SetOnline(ctx, id, online, at); err != nil {
		h.log.Error("store device status", "device", id, "err", err)
	}
	if h.publish != nil {
		b, _ := json.Marshal(StatusEvent{DeviceID: id, Online: online, At: at.UnixMilli()})
		if err := h.publish(telemetry.InternalStatusTopic, b, false, 1); err != nil {
			h.log.Error("publish device status", "device", id, "err", err)
		}
	}
}

func reason(err error) string {
	for _, e := range []error{
		telemetry.ErrBadTopic, telemetry.ErrBadDeviceID, telemetry.ErrTooLarge, telemetry.ErrBadJSON,
		telemetry.ErrBadSeq, telemetry.ErrNoMetrics, telemetry.ErrTooMany, telemetry.ErrBadMetric, telemetry.ErrNonFinite,
	} {
		if errors.Is(err, e) {
			return e.Error()
		}
	}
	return "other"
}
