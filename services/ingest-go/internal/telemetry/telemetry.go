// Package telemetry holds the device telemetry wire format and the rules that
// decide whether a message from a device is accepted, corrected, or rejected.
//
// Nothing in here touches the network or the database, so every rule is unit
// testable on its own.
package telemetry

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

// TopicPrefix and TopicSuffix bracket the device id in the telemetry topic:
// pulse/v1/devices/{deviceId}/telemetry
const (
	TopicPrefix = "pulse/v1/devices/"
	TopicSuffix = "/telemetry"

	// InternalReadingsTopic is where validated readings are republished for
	// downstream consumers (rules engine, realtime gateway).
	InternalReadingsTopic = "pulse/v1/internal/readings"
	// InternalStatusTopic carries device online/offline transitions.
	InternalStatusTopic = "pulse/v1/internal/status"

	MaxMetrics       = 32
	MaxPayloadBytes  = 4096
	MaxClockSkew     = 5 * time.Minute
	seqResetDistance = 1000
)

var (
	deviceIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	metricNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
)

// Rejection reasons. They double as Prometheus label values, so keep the set
// small and fixed.
var (
	ErrBadTopic    = errors.New("bad_topic")
	ErrTooLarge    = errors.New("too_large")
	ErrBadJSON     = errors.New("bad_json")
	ErrBadSeq      = errors.New("bad_seq")
	ErrNoMetrics   = errors.New("no_metrics")
	ErrTooMany     = errors.New("too_many_metrics")
	ErrBadMetric   = errors.New("bad_metric")
	ErrNonFinite   = errors.New("non_finite")
	ErrDuplicate   = errors.New("duplicate")
	ErrIDMismatch  = errors.New("id_mismatch")
	ErrBadDeviceID = errors.New("bad_device_id")
)

// Payload is what a device sends.
type Payload struct {
	// Boot is a random id the device picks at power-on. Sequence numbers are
	// only comparable within one boot: after a reboot seq starts again at 1.
	Boot    uint32             `json:"boot"`
	Seq     *int64             `json:"seq"`
	TS      int64              `json:"ts"` // unix millis, device clock
	Metrics map[string]float64 `json:"metrics"`
}

// Reading is a validated, normalised telemetry sample.
type Reading struct {
	DeviceID   string             `json:"deviceId"`
	Boot       uint32             `json:"boot,omitempty"`
	Seq        int64              `json:"seq"`
	TS         int64              `json:"ts"`         // unix millis, trusted
	ReceivedAt int64              `json:"receivedAt"` // unix millis, server clock
	Metrics    map[string]float64 `json:"metrics"`
	ClockSkew  bool               `json:"clockSkew,omitempty"`
}

// ValidDeviceID reports whether id is an acceptable device identifier.
func ValidDeviceID(id string) bool { return deviceIDPattern.MatchString(id) }

// DeviceIDFromTopic extracts the device id from a telemetry topic.
func DeviceIDFromTopic(topic string) (string, error) {
	if !strings.HasPrefix(topic, TopicPrefix) || !strings.HasSuffix(topic, TopicSuffix) {
		return "", ErrBadTopic
	}
	id := strings.TrimSuffix(strings.TrimPrefix(topic, TopicPrefix), TopicSuffix)
	if !ValidDeviceID(id) {
		return "", ErrBadDeviceID
	}
	return id, nil
}

// TelemetryTopic builds the telemetry topic for a device.
func TelemetryTopic(deviceID string) string { return TopicPrefix + deviceID + TopicSuffix }

// Parse validates raw bytes received on topic at time now.
//
// Device clocks are not trusted: an ESP32 without NTP boots at 1970. If the
// device timestamp is further than MaxClockSkew from the server clock, the
// server time is used instead and the reading is flagged.
func Parse(topic string, raw []byte, now time.Time) (Reading, error) {
	id, err := DeviceIDFromTopic(topic)
	if err != nil {
		return Reading{}, err
	}
	if len(raw) > MaxPayloadBytes {
		return Reading{}, ErrTooLarge
	}
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return Reading{}, fmt.Errorf("%w: %v", ErrBadJSON, err)
	}
	if p.Seq == nil || *p.Seq < 0 {
		return Reading{}, ErrBadSeq
	}
	if len(p.Metrics) == 0 {
		return Reading{}, ErrNoMetrics
	}
	if len(p.Metrics) > MaxMetrics {
		return Reading{}, ErrTooMany
	}
	for name, v := range p.Metrics {
		if !metricNamePattern.MatchString(name) {
			return Reading{}, fmt.Errorf("%w: %q", ErrBadMetric, name)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return Reading{}, fmt.Errorf("%w: %q", ErrNonFinite, name)
		}
	}

	nowMs := now.UnixMilli()
	r := Reading{DeviceID: id, Boot: p.Boot, Seq: *p.Seq, TS: p.TS, ReceivedAt: nowMs, Metrics: p.Metrics}
	if skew := time.Duration(abs(nowMs-p.TS)) * time.Millisecond; skew > MaxClockSkew {
		r.TS = nowMs
		r.ClockSkew = true
	}
	return r, nil
}

// SeqState is the newest (boot, seq) accepted from a device.
type SeqState struct {
	Boot uint32
	Seq  int64
}

// IsDuplicate decides whether (boot, seq) has already been accepted.
//
// MQTT QoS 1 is at-least-once, so redelivery is normal and must be dropped.
// A device that reboots picks a new boot id and starts seq again from 1, so
// a different boot id always starts a fresh sequence. Comparing seq alone is
// not enough: a device that rebooted after 400 readings would otherwise have
// its next 400 readings thrown away as "duplicates".
//
// Legacy devices that send no boot id (0) fall back to a heuristic: only a
// large backwards jump counts as a reboot.
func IsDuplicate(last SeqState, seen bool, boot uint32, seq int64) bool {
	if !seen || boot != last.Boot {
		return false
	}
	if seq > last.Seq {
		return false
	}
	if boot == 0 {
		return last.Seq-seq < seqResetDistance
	}
	return true
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
