package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/StrongMind0/pulse/services/ingest-go/internal/telemetry"
)

type fakeWriter struct {
	mu       sync.Mutex
	batches  [][]telemetry.Reading
	failNext int
	block    chan struct{}
}

func (f *fakeWriter) InsertBatch(_ context.Context, b []telemetry.Reading) error {
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext > 0 {
		f.failNext--
		return errors.New("disk on fire")
	}
	f.batches = append(f.batches, append([]telemetry.Reading(nil), b...))
	return nil
}

func (f *fakeWriter) total() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, b := range f.batches {
		n += len(b)
	}
	return n
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func cfg() Config {
	return Config{QueueSize: 100, BatchSize: 10, FlushInterval: 20 * time.Millisecond, MaxRetries: 2, RetryBackoff: time.Millisecond}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestBatchesBySizeAndTime(t *testing.T) {
	w := &fakeWriter{}
	var committed int
	var mu sync.Mutex
	p := New(cfg(), w, func(b []telemetry.Reading) { mu.Lock(); committed += len(b); mu.Unlock() }, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)

	for i := 0; i < 25; i++ {
		if !p.Offer(telemetry.Reading{DeviceID: "d", Seq: int64(i)}) {
			t.Fatal("offer rejected with free capacity")
		}
	}
	// 2 full batches by size, the remaining 5 by the flush timer
	waitFor(t, func() bool { return w.total() == 25 })
	mu.Lock()
	if committed != 25 {
		t.Fatalf("onCommit saw %d readings, want 25", committed)
	}
	mu.Unlock()
	cancel()
	<-p.Done()
}

func TestOfferShedsLoadWhenFull(t *testing.T) {
	w := &fakeWriter{block: make(chan struct{})}
	c := cfg()
	c.QueueSize = 5
	p := New(c, w, nil, quiet)
	// writer is not running, so the queue fills up
	accepted := 0
	for i := 0; i < 10; i++ {
		if p.Offer(telemetry.Reading{Seq: int64(i)}) {
			accepted++
		}
	}
	if accepted != 5 {
		t.Fatalf("accepted %d, want exactly queue size 5", accepted)
	}
}

func TestRetriesThenSucceeds(t *testing.T) {
	w := &fakeWriter{failNext: 2}
	p := New(cfg(), w, nil, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	p.Offer(telemetry.Reading{Seq: 1})
	waitFor(t, func() bool { return w.total() == 1 })
	cancel()
	<-p.Done()
}

func TestGivesUpAfterMaxRetries(t *testing.T) {
	w := &fakeWriter{failNext: 100}
	committed := false
	p := New(cfg(), w, func([]telemetry.Reading) { committed = true }, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	p.Offer(telemetry.Reading{Seq: 1})
	waitFor(t, func() bool { w.mu.Lock(); defer w.mu.Unlock(); return w.failNext == 97 })
	time.Sleep(30 * time.Millisecond)
	cancel()
	<-p.Done()
	if committed || w.total() != 0 {
		t.Fatal("a failed batch must not be announced as committed")
	}
}

func TestShutdownDrainsQueue(t *testing.T) {
	w := &fakeWriter{}
	c := cfg()
	c.FlushInterval = time.Hour // only shutdown can flush
	c.BatchSize = 1000
	p := New(c, w, nil, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	for i := 0; i < 42; i++ {
		p.Offer(telemetry.Reading{Seq: int64(i)})
	}
	time.Sleep(10 * time.Millisecond)
	cancel()
	<-p.Done()
	if w.total() != 42 {
		t.Fatalf("persisted %d on shutdown, want 42", w.total())
	}
}
