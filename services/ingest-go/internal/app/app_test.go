package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/pipeline"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

const (
	devTok = "device-secret"
	svcTok = "service-secret"
)

func startApp(t *testing.T) *App {
	t.Helper()
	pc := pipeline.DefaultConfig()
	pc.FlushInterval = 20 * time.Millisecond
	a, err := New(Config{
		MQTTAddr: "127.0.0.1:0", HTTPAddr: "127.0.0.1:0",
		DBPath:      filepath.Join(t.TempDir(), "it.db"),
		DeviceToken: devTok, ServiceToken: svcTok, Pipeline: pc,
	}, slog.New(slog.NewTextHandler(testLogOut(), &slog.HandlerOptions{Level: slog.LevelDebug})))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = a.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	time.Sleep(100 * time.Millisecond)
	return a
}

func connect(t *testing.T, addr, clientID, user, pass string) (paho.Client, error) {
	t.Helper()
	opts := paho.NewClientOptions().AddBroker("tcp://" + addr).
		SetClientID(clientID).SetUsername(user).SetPassword(pass).
		SetAutoReconnect(false).SetConnectTimeout(2 * time.Second)
	c := paho.NewClient(opts)
	tok := c.Connect()
	if !tok.WaitTimeout(3 * time.Second) {
		return nil, fmt.Errorf("connect timeout")
	}
	if tok.Error() != nil {
		return nil, tok.Error()
	}
	t.Cleanup(func() { c.Disconnect(50) })
	return c, nil
}

func publish(t *testing.T, c paho.Client, topic, body string) {
	t.Helper()
	tok := c.Publish(topic, 1, false, body)
	tok.WaitTimeout(2 * time.Second)
}

func TestEndToEnd(t *testing.T) {
	a := startApp(t)

	// A backend service listens to the validated stream.
	svc, err := connect(t, a.MQTTAddr(), "rules", "svc:rules", svcTok)
	if err != nil {
		t.Fatalf("service connect: %v", err)
	}
	var mu sync.Mutex
	var readings []telemetry.Reading
	var statuses []string
	svc.Subscribe("pulse/v1/internal/#", 1, func(_ paho.Client, m paho.Message) {
		mu.Lock()
		defer mu.Unlock()
		switch m.Topic() {
		case telemetry.InternalReadingsTopic:
			var r telemetry.Reading
			_ = json.Unmarshal(m.Payload(), &r)
			readings = append(readings, r)
		case telemetry.InternalStatusTopic:
			statuses = append(statuses, string(m.Payload()))
		}
	}).WaitTimeout(2 * time.Second)

	dev, err := connect(t, a.MQTTAddr(), "pump-01", "pump-01", devTok)
	if err != nil {
		t.Fatalf("device connect: %v", err)
	}
	topic := telemetry.TelemetryTopic("pump-01")
	now := time.Now().UnixMilli()
	for seq := 1; seq <= 3; seq++ {
		publish(t, dev, topic, fmt.Sprintf(`{"seq":%d,"ts":%d,"metrics":{"temperature_c":%d}}`, seq, now, 20+seq))
	}
	publish(t, dev, topic, fmt.Sprintf(`{"seq":2,"ts":%d,"metrics":{"temperature_c":99}}`, now)) // QoS1 redelivery
	publish(t, dev, topic, `{"seq":4,"metrics":{"temperature_c":"hot"}}`)                        // invalid

	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(readings)
		mu.Unlock()
		if n >= 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // allow any wrongly-accepted extras to arrive

	mu.Lock()
	if len(readings) != 3 {
		t.Fatalf("got %d readings on internal topic, want 3: %+v", len(readings), readings)
	}
	for i, r := range readings {
		if r.DeviceID != "pump-01" || r.Seq != int64(i+1) {
			t.Fatalf("reading %d unexpected: %+v", i, r)
		}
	}
	if len(statuses) == 0 {
		t.Fatal("expected an online status event")
	}
	mu.Unlock()

	resp, err := http.Get("http://" + a.HTTPAddr() + "/api/v1/devices")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Devices []struct {
			ID           string `json:"id"`
			Online       bool   `json:"online"`
			ReadingCount int    `json:"readingCount"`
		} `json:"devices"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if len(body.Devices) != 1 || body.Devices[0].ID != "pump-01" || !body.Devices[0].Online || body.Devices[0].ReadingCount != 3 {
		t.Fatalf("unexpected devices response %+v", body)
	}
}

// MQTT 3.1.1 has no negative PUBACK, so a publish outside a client's ACL is
// answered by disconnecting it. The forged message must never be accepted.
func TestACLViolationsDisconnectAndAreDiscarded(t *testing.T) {
	a := startApp(t)
	now := time.Now().UnixMilli()
	forged := fmt.Sprintf(`{"seq":1,"ts":%d,"metrics":{"temperature_c":1}}`, now)

	dev, err := connect(t, a.MQTTAddr(), "pump-01", "pump-01", devTok)
	if err != nil {
		t.Fatal(err)
	}
	publish(t, dev, telemetry.TelemetryTopic("fan-02"), forged) // device impersonating another device

	svc, err := connect(t, a.MQTTAddr(), "rules", "svc:rules", svcTok)
	if err != nil {
		t.Fatal(err)
	}
	publish(t, svc, telemetry.TelemetryTopic("pump-01"), forged) // service injecting device data

	deadline := time.Now().Add(2 * time.Second)
	for (dev.IsConnectionOpen() || svc.IsConnectionOpen()) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if dev.IsConnectionOpen() || svc.IsConnectionOpen() {
		t.Fatalf("violators should be disconnected (device open=%v, service open=%v)", dev.IsConnectionOpen(), svc.IsConnectionOpen())
	}
	time.Sleep(50 * time.Millisecond) // give a wrongly-accepted reading time to flush

	resp, err := http.Get("http://" + a.HTTPAddr() + "/api/v1/devices")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Devices []struct {
			ID           string `json:"id"`
			ReadingCount int    `json:"readingCount"`
		} `json:"devices"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	for _, d := range body.Devices {
		if d.ReadingCount != 0 {
			t.Fatalf("forged telemetry was persisted: %+v", body.Devices)
		}
	}
}

func TestAuthRejections(t *testing.T) {
	a := startApp(t)
	cases := []struct{ name, client, user, pass string }{
		{"wrong device token", "pump-01", "pump-01", "nope"},
		{"username differs from client id", "pump-01", "pump-02", devTok},
		{"invalid device id", "PUMP!", "PUMP!", devTok},
		{"service with device token", "rules", "svc:rules", devTok},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := connect(t, a.MQTTAddr(), tc.client, tc.user, tc.pass); err == nil {
				t.Fatal("expected connection to be refused")
			}
		})
	}
}

func TestReadingsEndpointValidation(t *testing.T) {
	a := startApp(t)
	for path, want := range map[string]int{
		"/api/v1/devices/pump-01/readings":           200,
		"/api/v1/devices/pump-01/readings?limit=0":   400,
		"/api/v1/devices/pump-01/readings?limit=abc": 400,
		"/api/v1/devices/Bad_ID/readings":            400,
		"/healthz":                                   200,
		"/readyz":                                    200,
	} {
		resp, err := http.Get("http://" + a.HTTPAddr() + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%s: got %d want %d", path, resp.StatusCode, want)
		}
	}
}

func testLogOut() io.Writer {
	if os.Getenv("PULSE_TEST_LOG") == "1" {
		return os.Stderr
	}
	return io.Discard
}
