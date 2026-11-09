// Package app wires the broker, pipeline, store and HTTP API into one
// runnable service. main stays tiny and integration tests boot the real thing.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/listeners"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/api"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/broker"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/pipeline"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/store"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

type Config struct {
	MQTTAddr     string
	HTTPAddr     string
	DBPath       string
	DeviceToken  string
	ServiceToken string
	Retention    time.Duration
	Pipeline     pipeline.Config
}

type App struct {
	cfg      Config
	log      *slog.Logger
	store    *store.SQLite
	server   *mqtt.Server
	pipe     *pipeline.Pipeline
	http     *http.Server
	httpLn   net.Listener
	mqttAddr string
}

func New(cfg Config, log *slog.Logger) (*App, error) {
	if cfg.DeviceToken == "" || cfg.ServiceToken == "" {
		return nil, errors.New("device and service tokens must be set")
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	ctx := context.Background()
	if err := st.MarkAllOffline(ctx); err != nil {
		return nil, err
	}
	seed, err := st.LastSeqs(ctx)
	if err != nil {
		return nil, err
	}

	srv := mqtt.New(&mqtt.Options{InlineClient: true, Logger: log.With("component", "mqtt")})
	a := &App{cfg: cfg, log: log, store: st, server: srv}

	a.pipe = pipeline.New(cfg.Pipeline, st, a.announce, log.With("component", "pipeline"))
	hook := broker.NewHook(broker.Config{DeviceToken: cfg.DeviceToken, ServiceToken: cfg.ServiceToken},
		a.pipe, st, srv.Publish, seed, log.With("component", "broker"))
	if err := srv.AddHook(hook, nil); err != nil {
		return nil, err
	}

	// Bind sockets up front so ":0" works in tests and port clashes fail fast.
	mqttLn, err := net.Listen("tcp", cfg.MQTTAddr)
	if err != nil {
		return nil, fmt.Errorf("listen mqtt: %w", err)
	}
	a.mqttAddr = mqttLn.Addr().String()
	mqttLn.Close() // mochi binds its own listener; the brief gap is acceptable at startup
	if err := srv.AddListener(listeners.NewTCP(listeners.Config{ID: "tcp", Address: a.mqttAddr})); err != nil {
		return nil, err
	}

	a.httpLn, err = net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		return nil, fmt.Errorf("listen http: %w", err)
	}
	a.http = &http.Server{
		Handler:           api.Handler(st, a.pipe, cfg.Pipeline.QueueSize, log),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
	}
	return a, nil
}

func (a *App) MQTTAddr() string { return a.mqttAddr }
func (a *App) HTTPAddr() string { return a.httpLn.Addr().String() }

// announce republishes a committed batch for downstream consumers.
func (a *App) announce(batch []telemetry.Reading) {
	for _, r := range batch {
		b, err := json.Marshal(r)
		if err != nil {
			continue
		}
		if err := a.server.Publish(telemetry.InternalReadingsTopic, b, false, 0); err != nil {
			a.log.Error("announce reading", "err", err)
		}
	}
}

// Run serves until ctx is cancelled, then shuts down in dependency order:
// stop accepting device traffic, drain the queue to the store, stop HTTP.
func (a *App) Run(ctx context.Context) error {
	pipeCtx, stopPipe := context.WithCancel(context.Background())
	go a.pipe.Run(pipeCtx)

	if err := a.server.Serve(); err != nil {
		stopPipe()
		return fmt.Errorf("mqtt serve: %w", err)
	}
	httpErr := make(chan error, 1)
	go func() {
		if err := a.http.Serve(a.httpLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			httpErr <- err
		}
	}()
	go a.pruneLoop(pipeCtx)

	a.log.Info("pulse ingest running", "mqtt", a.mqttAddr, "http", a.HTTPAddr())

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-httpErr:
	}

	a.log.Info("shutting down")
	_ = a.server.Close()
	stopPipe()
	<-a.pipe.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = a.http.Shutdown(shutdownCtx)
	_ = a.store.Close()
	return runErr
}

func (a *App) pruneLoop(ctx context.Context) {
	if a.cfg.Retention <= 0 {
		return
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := a.store.Prune(ctx, time.Now().Add(-a.cfg.Retention))
			if err != nil {
				a.log.Error("prune", "err", err)
			} else if n > 0 {
				a.log.Info("pruned old readings", "rows", n)
			}
		}
	}
}
