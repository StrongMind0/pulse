package dev.pulse.rules.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class AlertEngineTest {

    /** Hand-cranked clock so time-based behaviour is deterministic. */
    static final class TestClock extends Clock {
        long now = 1_000_000;

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return Instant.ofEpochMilli(now);
        }
    }

    TestClock clock;
    AlertStore store;
    List<AlertEvent> events;

    @BeforeEach
    void setUp() {
        clock = new TestClock();
        store = new AlertStore(100);
        events = new ArrayList<>();
    }

    AlertEngine engine(Rule... rules) {
        return new AlertEngine(List.of(rules), store, clock, events::add);
    }

    static Reading reading(String device, long seq, long ts, double temp) {
        return new Reading(device, seq, ts, ts, Map.of("temperature_c", temp));
    }

    static final Rule.Threshold OVERHEAT =
            new Rule.Threshold("overheat", "Overheat", Severity.CRITICAL, "pump-", 3_000, "temperature_c", 75, 70);

    @Nested
    class ThresholdWithHoldAndHysteresis {

        @Test
        void firesOnlyAfterConditionHoldsForTheConfiguredDuration() {
            AlertEngine e = engine(OVERHEAT);
            e.onReading(reading("pump-01", 1, 0, 80));
            e.onReading(reading("pump-01", 2, 2_000, 81));
            assertThat(events).isEmpty();
            e.onReading(reading("pump-01", 3, 3_000, 82));
            assertThat(events).singleElement().satisfies(ev -> {
                assertThat(ev.type()).isEqualTo(AlertEvent.Type.FIRED);
                assertThat(ev.alert().deviceId()).isEqualTo("pump-01");
                assertThat(ev.alert().message()).contains("temperature_c is 82.00");
            });
        }

        @Test
        void aBriefSpikeDoesNotFire() {
            AlertEngine e = engine(OVERHEAT);
            e.onReading(reading("pump-01", 1, 0, 90));
            e.onReading(reading("pump-01", 2, 1_000, 50)); // spike gone: pending timer resets
            e.onReading(reading("pump-01", 3, 2_000, 90));
            e.onReading(reading("pump-01", 4, 4_000, 90));
            assertThat(events).isEmpty();
        }

        @Test
        void hoveringNearTheLimitDoesNotFlap() {
            AlertEngine e = engine(OVERHEAT);
            long t = 0;
            for (int i = 0; i < 5; i++) {
                e.onReading(reading("pump-01", i, t += 1_000, 80));
            }
            // oscillate between 72 and 76: above clear (70), so it must stay firing
            for (int i = 0; i < 20; i++) {
                e.onReading(reading("pump-01", 10 + i, t += 1_000, i % 2 == 0 ? 72 : 76));
            }
            assertThat(events).extracting(AlertEvent::type).containsExactly(AlertEvent.Type.FIRED);
            e.onReading(reading("pump-01", 99, t + 1_000, 60));
            assertThat(events).extracting(AlertEvent::type)
                    .containsExactly(AlertEvent.Type.FIRED, AlertEvent.Type.RESOLVED);
            assertThat(store.firingCount()).isZero();
        }

        @Test
        void oneOpenAlertPerDeviceAndRule() {
            AlertEngine e = engine(OVERHEAT);
            for (int i = 0; i < 50; i++) {
                e.onReading(reading("pump-01", i, i * 1_000L, 90));
            }
            assertThat(events).hasSize(1);
            assertThat(store.firingCount()).isEqualTo(1);
        }

        @Test
        void rulesOnlyApplyToMatchingDevices() {
            AlertEngine e = engine(OVERHEAT);
            for (int i = 0; i < 10; i++) {
                e.onReading(reading("motor-01", i, i * 1_000L, 90));
            }
            assertThat(events).isEmpty();
        }

        @Test
        void outOfOrderReadingsAreSkippedNotEvaluated() {
            AlertEngine e = engine(OVERHEAT);
            e.onReading(reading("pump-01", 2, 10_000, 50));
            e.onReading(reading("pump-01", 1, 5_000, 99)); // late arrival from the past
            assertThat(e.outOfOrderCount()).isEqualTo(1);
            assertThat(e.evaluatedCount()).isEqualTo(1);
        }
    }

    @Test
    void rateOfChangeCatchesOverheatingBeforeTheHardLimit() {
        AlertEngine e = engine(new Rule.RateOfChange("rising", "Rising", Severity.WARNING, "", 0,
                "temperature_c", 0.8, 10_000));
        double temp = 48;
        for (int i = 0; i <= 10; i++) {
            e.onReading(reading("pump-01", i, i * 1_000L, temp));
            temp += 1.5;
        }
        assertThat(events).singleElement().satisfies(ev -> {
            assertThat(ev.alert().message()).contains("rising 1.50/s");
            assertThat(ev.alert().triggerValue()).isLessThan(75); // fired while still under the hard limit
        });
    }

    @Test
    void flatlineDetectsAStuckSensorButNotANoisyOne() {
        AlertEngine e = engine(new Rule.Flatline("stuck", "Stuck", Severity.WARNING, "", 0, 5));
        for (int i = 0; i < 10; i++) {
            e.onReading(reading("env-01", i, i * 1_000L, 21.0 + (i % 3) * 0.1));
        }
        assertThat(events).isEmpty();
        for (int i = 10; i < 15; i++) {
            e.onReading(reading("env-01", i, i * 1_000L, 21.337));
        }
        assertThat(events).singleElement().satisfies(ev -> assertThat(ev.alert().message()).contains("temperature_c unchanged"));
        e.onReading(reading("env-01", 15, 15_000, 21.4));
        assertThat(events).extracting(AlertEvent::type).containsExactly(AlertEvent.Type.FIRED, AlertEvent.Type.RESOLVED);
    }

    @Test
    void silenceFiresOnSweepAndClearsWhenDataReturns() {
        AlertEngine e = engine(new Rule.Silence("silent", "Silent", Severity.CRITICAL, "", 0, 15_000));
        e.onReading(reading("pump-01", 1, 0, 50));
        clock.now += 10_000;
        e.sweep();
        assertThat(events).isEmpty();
        clock.now += 6_000;
        e.sweep();
        e.sweep(); // repeated sweeps must not duplicate the alert
        assertThat(events).singleElement().satisfies(ev -> assertThat(ev.alert().ruleId()).isEqualTo("silent"));
        e.onReading(reading("pump-01", 2, 16_000, 50));
        assertThat(events).extracting(AlertEvent::type).containsExactly(AlertEvent.Type.FIRED, AlertEvent.Type.RESOLVED);
    }

    @Test
    void acknowledgeIsIdempotent() {
        AlertEngine e = engine(new Rule.Threshold("hot", "Hot", Severity.WARNING, "", 0, "temperature_c", 75, 70));
        e.onReading(reading("pump-01", 1, 0, 90));
        String id = events.getFirst().alert().id();

        clock.now += 1_000;
        Alert first = e.acknowledge(id, "alice").orElseThrow();
        clock.now += 1_000;
        Alert second = e.acknowledge(id, "bob").orElseThrow();

        assertThat(second.acknowledgedBy()).isEqualTo("alice");
        assertThat(second.acknowledgedAt()).isEqualTo(first.acknowledgedAt());
        assertThat(events).extracting(AlertEvent::type).containsExactly(AlertEvent.Type.FIRED, AlertEvent.Type.ACKNOWLEDGED);
        assertThat(e.acknowledge("missing", "alice")).isEmpty();
    }

    @Test
    void concurrentDevicesProduceExactlyOneAlertEach() throws Exception {
        AlertEngine e = new AlertEngine(List.of(new Rule.Threshold("hot", "Hot", Severity.WARNING, "", 0,
                "temperature_c", 75, 70)), store, clock, ev -> { });
        int devices = 50;
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch start = new CountDownLatch(1);
        for (int d = 0; d < devices; d++) {
            String id = "pump-%02d".formatted(d);
            for (int t = 0; t < 4; t++) { // 4 threads hammer each device
                pool.submit(() -> {
                    start.await();
                    for (int i = 0; i < 100; i++) {
                        e.onReading(reading(id, i, i, 90));
                    }
                    return null;
                });
            }
        }
        start.countDown();
        pool.shutdown();
        assertThat(pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(store.firingCount()).isEqualTo(devices);
    }

    @Test
    void storeEvictsOldestResolvedButKeepsFiring() {
        AlertStore small = new AlertStore(2);
        for (int i = 0; i < 5; i++) {
            Alert a = new Alert("a" + i, "d", "r", "R", Severity.INFO, Alert.State.FIRING, "m", 1, i, null, null, null);
            small.save(a);
            if (i < 4) {
                small.save(a.resolve(i + 1, "ok"));
            }
        }
        assertThat(small.size()).isEqualTo(3); // 2 resolved + 1 firing
        assertThat(small.find("a0")).isEmpty();
        assertThat(small.find("a4")).isPresent();
        assertThat(small.firingCount()).isEqualTo(1);
    }

    @Test
    void thresholdRejectsInvertedHysteresis() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                new Rule.Threshold("x", "x", Severity.INFO, "", 0, "m", 10, 20))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
