// Package pipeline moves validated readings from the MQTT hook to the store.
//
// Design:
//   - Offer never blocks. The MQTT broker calls it on its own goroutines, and
//     a slow database must not stall every connected device. When the queue
//     is full the reading is dropped and counted (load shedding).
//   - A single writer drains the queue in batches: flush when the batch is
//     full or the flush interval passes, whichever comes first.
//   - Readings are announced downstream only after they are committed, so a
//     consumer never acts on data that later turns out not to exist.
package pipeline

import (
	"context"
	"log/slog"
	"time"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/metrics"
	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

// Writer is the subset of the store the pipeline needs.
type Writer interface {
	InsertBatch(ctx context.Context, batch []telemetry.Reading) error
}

type Config struct {
	QueueSize     int
	BatchSize     int
	FlushInterval time.Duration
	MaxRetries    int
	RetryBackoff  time.Duration
}

func DefaultConfig() Config {
	return Config{QueueSize: 10_000, BatchSize: 500, FlushInterval: 250 * time.Millisecond, MaxRetries: 5, RetryBackoff: 100 * time.Millisecond}
}

type Pipeline struct {
	cfg      Config
	in       chan telemetry.Reading
	w        Writer
	onCommit func([]telemetry.Reading)
	log      *slog.Logger
	done     chan struct{}
}

// New creates a pipeline. onCommit is called (on the writer goroutine) with
// each batch after it is durably stored; it may be nil.
func New(cfg Config, w Writer, onCommit func([]telemetry.Reading), log *slog.Logger) *Pipeline {
	return &Pipeline{cfg: cfg, in: make(chan telemetry.Reading, cfg.QueueSize), w: w, onCommit: onCommit, log: log, done: make(chan struct{})}
}

// Offer enqueues r without blocking and reports whether it was accepted.
func (p *Pipeline) Offer(r telemetry.Reading) bool {
	select {
	case p.in <- r:
		metrics.QueueDepth.Set(float64(len(p.in)))
		return true
	default:
		metrics.Dropped.WithLabelValues("queue_full").Inc()
		return false
	}
}

// Depth is the number of readings waiting to be written.
func (p *Pipeline) Depth() int { return len(p.in) }

// Done is closed once Run has drained and returned.
func (p *Pipeline) Done() <-chan struct{} { return p.done }

// Run drains the queue until ctx is cancelled, then flushes what is left
// using drainCtx so shutdown does not lose buffered readings.
func (p *Pipeline) Run(ctx context.Context) {
	defer close(p.done)
	ticker := time.NewTicker(p.cfg.FlushInterval)
	defer ticker.Stop()
	batch := make([]telemetry.Reading, 0, p.cfg.BatchSize)

	flush := func(c context.Context) {
		if len(batch) == 0 {
			return
		}
		p.write(c, batch)
		batch = make([]telemetry.Reading, 0, p.cfg.BatchSize)
	}

	for {
		select {
		case r := <-p.in:
			batch = append(batch, r)
			if len(batch) >= p.cfg.BatchSize {
				flush(ctx)
			}
		case <-ticker.C:
			flush(ctx)
		case <-ctx.Done():
			drainCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			for {
				select {
				case r := <-p.in:
					batch = append(batch, r)
					if len(batch) >= p.cfg.BatchSize {
						flush(drainCtx)
					}
				default:
					flush(drainCtx)
					return
				}
			}
		}
		metrics.QueueDepth.Set(float64(len(p.in)))
	}
}

func (p *Pipeline) write(ctx context.Context, batch []telemetry.Reading) {
	backoff := p.cfg.RetryBackoff
	for attempt := 0; ; attempt++ {
		start := time.Now()
		err := p.w.InsertBatch(ctx, batch)
		if err == nil {
			metrics.FlushSeconds.Observe(time.Since(start).Seconds())
			metrics.BatchSize.Observe(float64(len(batch)))
			metrics.Persisted.Add(float64(len(batch)))
			if p.onCommit != nil {
				p.onCommit(batch)
			}
			return
		}
		metrics.StoreErrors.Inc()
		if attempt >= p.cfg.MaxRetries || ctx.Err() != nil {
			// Giving up is a deliberate choice: blocking forever would turn a
			// store outage into a memory leak. The loss is visible in metrics.
			p.log.Error("dropping batch after store failures", "size", len(batch), "attempts", attempt+1, "err", err)
			metrics.Dropped.WithLabelValues("store_failure").Add(float64(len(batch)))
			return
		}
		p.log.Warn("store write failed, retrying", "attempt", attempt+1, "backoff", backoff, "err", err)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
		}
		backoff *= 2
	}
}
