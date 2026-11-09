package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/app"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/pipeline"
)

func main() {
	// `ingest healthcheck` lets a distroless container (no shell, no curl)
	// probe itself.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(env("PULSE_HTTP_ADDR", ":8081")))
	}

	level := slog.LevelInfo
	if os.Getenv("PULSE_DEBUG") == "1" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	pc := pipeline.DefaultConfig()
	pc.QueueSize = envInt("PULSE_QUEUE_SIZE", pc.QueueSize)
	pc.BatchSize = envInt("PULSE_BATCH_SIZE", pc.BatchSize)

	cfg := app.Config{
		MQTTAddr:     env("PULSE_MQTT_ADDR", ":1883"),
		HTTPAddr:     env("PULSE_HTTP_ADDR", ":8081"),
		DBPath:       env("PULSE_DB_PATH", "pulse-ingest.db"),
		DeviceToken:  env("PULSE_DEVICE_TOKEN", ""),
		ServiceToken: env("PULSE_SERVICE_TOKEN", ""),
		Retention:    time.Duration(envInt("PULSE_RETENTION_HOURS", 72)) * time.Hour,
		Pipeline:     pc,
	}

	a, err := app.New(cfg, log)
	if err != nil {
		log.Error("startup failed", "err", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := a.Run(ctx); err != nil {
		log.Error("exited with error", "err", err)
		os.Exit(1)
	}
}

func healthcheck(addr string) int {
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get("http://" + addr + "/readyz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return def
}
