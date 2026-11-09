package telemetry

import (
	"errors"
	"strings"
	"testing"
	"time"
)

var now = time.UnixMilli(1_760_000_000_000)

func TestParse(t *testing.T) {
	topic := TelemetryTopic("pump-01")
	cases := []struct {
		name    string
		topic   string
		body    string
		wantErr error
		check   func(t *testing.T, r Reading)
	}{
		{
			name:  "valid reading keeps device timestamp",
			topic: topic,
			body:  `{"seq":7,"ts":1759999999000,"metrics":{"temperature_c":21.5}}`,
			check: func(t *testing.T, r Reading) {
				if r.DeviceID != "pump-01" || r.Seq != 7 || r.TS != 1759999999000 || r.ClockSkew {
					t.Fatalf("unexpected reading %+v", r)
				}
			},
		},
		{
			name:  "device clock at epoch is replaced by server time",
			topic: topic,
			body:  `{"seq":1,"ts":0,"metrics":{"temperature_c":21.5}}`,
			check: func(t *testing.T, r Reading) {
				if !r.ClockSkew || r.TS != now.UnixMilli() {
					t.Fatalf("expected clock skew correction, got %+v", r)
				}
			},
		},
		{name: "missing seq", topic: topic, body: `{"ts":1,"metrics":{"a":1}}`, wantErr: ErrBadSeq},
		{name: "negative seq", topic: topic, body: `{"seq":-1,"metrics":{"a":1}}`, wantErr: ErrBadSeq},
		{name: "no metrics", topic: topic, body: `{"seq":1,"metrics":{}}`, wantErr: ErrNoMetrics},
		{name: "bad metric name", topic: topic, body: `{"seq":1,"metrics":{"Temp C":1}}`, wantErr: ErrBadMetric},
		{name: "not json", topic: topic, body: `hello`, wantErr: ErrBadJSON},
		{name: "wrong topic shape", topic: "pulse/v1/devices/pump-01", body: `{}`, wantErr: ErrBadTopic},
		{name: "uppercase device id", topic: TelemetryTopic("Pump-01"), body: `{}`, wantErr: ErrBadDeviceID},
		{name: "wildcard smuggled in id", topic: TelemetryTopic("a/+"), body: `{}`, wantErr: ErrBadDeviceID},
		{name: "oversized payload", topic: topic, body: `{"seq":1,"metrics":{"a":1},"pad":"` + strings.Repeat("x", MaxPayloadBytes) + `"}`, wantErr: ErrTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, err := Parse(tc.topic, []byte(tc.body), now)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("want %v, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			tc.check(t, r)
		})
	}
}

func TestParseRejectsTooManyMetrics(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"seq":1,"metrics":{`)
	for i := 0; i <= MaxMetrics; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`"m` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `":1`)
	}
	b.WriteString(`}}`)
	if _, err := Parse(TelemetryTopic("pump-01"), []byte(b.String()), now); !errors.Is(err, ErrTooMany) {
		t.Fatalf("want ErrTooMany, got %v", err)
	}
}

func TestIsDuplicate(t *testing.T) {
	cases := []struct {
		name    string
		last    int64
		seen    bool
		seq     int64
		wantDup bool
	}{
		{"first message from device", 0, false, 0, false},
		{"next in sequence", 10, true, 11, false},
		{"gap forward is fine", 10, true, 50, false},
		{"exact redelivery", 10, true, 10, true},
		{"late redelivery", 10, true, 8, true},
		{"device rebooted and restarted at zero", 50_000, true, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsDuplicate(tc.last, tc.seen, tc.seq); got != tc.wantDup {
				t.Fatalf("IsDuplicate(%d,%v,%d)=%v want %v", tc.last, tc.seen, tc.seq, got, tc.wantDup)
			}
		})
	}
}

func BenchmarkParse(b *testing.B) {
	topic := TelemetryTopic("pump-01")
	body := []byte(`{"seq":7,"ts":1759999999000,"metrics":{"temperature_c":21.5,"humidity_pct":40.2,"vibration_g":0.012}}`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := Parse(topic, body, now); err != nil {
			b.Fatal(err)
		}
	}
}
