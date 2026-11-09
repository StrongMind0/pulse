package dev.pulse.rules.domain;

import java.time.Clock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Evaluates rules against each device's recent readings and drives one state
 * machine per (device, rule):
 *
 * <pre>
 *   OK --trigger--> PENDING --held for forMillis--> FIRING --clear--> OK
 *        PENDING --trigger stops--> OK
 * </pre>
 *
 * Guarantees:
 * <ul>
 *   <li>At most one open alert per device and rule (no duplicate pages).</li>
 *   <li>Durations use event time (reading timestamps), so a backlog replayed
 *       after an outage produces the same alerts as live traffic would.</li>
 *   <li>Out-of-order readings are counted and skipped rather than corrupting
 *       the window.</li>
 *   <li>Devices are locked individually: one noisy device never blocks others.</li>
 * </ul>
 */
public final class AlertEngine {

    static final int WINDOW_MAX = 64;
    static final long WINDOW_SPAN_MS = 120_000;

    private final List<Rule> rules;
    private final AlertStore store;
    private final Clock clock;
    private final Consumer<AlertEvent> sink;
    private final ConcurrentHashMap<String, DeviceState> devices = new ConcurrentHashMap<>();

    private final AtomicLong evaluated = new AtomicLong();
    private final AtomicLong outOfOrder = new AtomicLong();

    private enum Phase { OK, PENDING, FIRING }

    private static final class RuleState {
        Phase phase = Phase.OK;
        long pendingSince;
        String alertId;
    }

    private static final class DeviceState {
        final ArrayDeque<Reading> window = new ArrayDeque<>();
        final Map<String, RuleState> rules = new HashMap<>();
        long lastTs = Long.MIN_VALUE;
        long lastSeenLocal;
    }

    public AlertEngine(List<Rule> rules, AlertStore store, Clock clock, Consumer<AlertEvent> sink) {
        this.rules = List.copyOf(rules);
        this.store = store;
        this.clock = clock;
        this.sink = sink;
    }

    public List<Rule> rules() {
        return rules;
    }

    public long evaluatedCount() {
        return evaluated.get();
    }

    public long outOfOrderCount() {
        return outOfOrder.get();
    }

    public int trackedDevices() {
        return devices.size();
    }

    public List<AlertEvent> onReading(Reading r) {
        DeviceState s = devices.computeIfAbsent(r.deviceId(), k -> new DeviceState());
        List<AlertEvent> events = new ArrayList<>();
        synchronized (s) {
            s.lastSeenLocal = clock.millis();
            for (Rule rule : rules) {
                if (rule instanceof Rule.Silence silence && rule.appliesTo(r.deviceId())) {
                    // any reading at all proves the device is alive, even an out-of-order one
                    apply(s, r.deviceId(), silence, Signal.cleared(0, "device reporting again"), s.lastSeenLocal, events);
                }
            }
            if (r.ts() < s.lastTs) {
                outOfOrder.incrementAndGet();
            } else {
                s.lastTs = r.ts();
                s.window.addLast(r);
                while (s.window.size() > WINDOW_MAX || r.ts() - s.window.getFirst().ts() > WINDOW_SPAN_MS) {
                    s.window.removeFirst();
                }
                List<Reading> view = List.copyOf(s.window);
                for (Rule rule : rules) {
                    if (!(rule instanceof Rule.Silence) && rule.appliesTo(r.deviceId())) {
                        Optional<Signal> sig = rule.evaluate(view);
                        if (sig.isPresent()) {
                            apply(s, r.deviceId(), rule, sig.get(), r.ts(), events);
                        }
                    }
                }
                evaluated.incrementAndGet();
            }
        }
        events.forEach(sink);
        return events;
    }

    /** Periodic check for devices that have gone quiet. */
    public List<AlertEvent> sweep() {
        long now = clock.millis();
        List<AlertEvent> events = new ArrayList<>();
        devices.forEach((deviceId, s) -> {
            synchronized (s) {
                for (Rule rule : rules) {
                    if (rule instanceof Rule.Silence silence && rule.appliesTo(deviceId)) {
                        apply(s, deviceId, rule, silence.check(now - s.lastSeenLocal), now, events);
                    }
                }
            }
        });
        events.forEach(sink);
        return events;
    }

    /** Idempotent: acknowledging twice keeps the first acknowledgement. */
    public Optional<Alert> acknowledge(String alertId, String by) {
        Alert ack;
        synchronized (store) {
            Optional<Alert> current = store.find(alertId);
            if (current.isEmpty() || current.get().acknowledged()) {
                return current;
            }
            ack = current.get().acknowledge(clock.millis(), by);
            store.save(ack);
        }
        sink.accept(new AlertEvent(AlertEvent.Type.ACKNOWLEDGED, ack));
        return Optional.of(ack);
    }

    private void apply(DeviceState s, String deviceId, Rule rule, Signal sig, long at, List<AlertEvent> out) {
        RuleState rs = s.rules.computeIfAbsent(rule.id(), k -> new RuleState());
        switch (rs.phase) {
            case OK -> {
                if (sig.trigger()) {
                    if (rule.forMillis() <= 0) {
                        fire(rs, deviceId, rule, sig, at, out);
                    } else {
                        rs.phase = Phase.PENDING;
                        rs.pendingSince = at;
                    }
                }
            }
            case PENDING -> {
                if (!sig.trigger()) {
                    rs.phase = Phase.OK;
                } else if (at - rs.pendingSince >= rule.forMillis()) {
                    fire(rs, deviceId, rule, sig, at, out);
                }
            }
            case FIRING -> {
                if (sig.clear()) {
                    resolve(rs, sig, at, out);
                }
            }
        }
    }

    private void fire(RuleState rs, String deviceId, Rule rule, Signal sig, long at, List<AlertEvent> out) {
        Alert a = new Alert(UUID.randomUUID().toString(), deviceId, rule.id(), rule.name(), rule.severity(),
                Alert.State.FIRING, sig.detail(), sig.value(), clock.millis(), null, null, null);
        synchronized (store) {
            store.save(a);
        }
        rs.phase = Phase.FIRING;
        rs.alertId = a.id();
        out.add(new AlertEvent(AlertEvent.Type.FIRED, a));
    }

    private void resolve(RuleState rs, Signal sig, long at, List<AlertEvent> out) {
        rs.phase = Phase.OK;
        String id = rs.alertId;
        rs.alertId = null;
        Alert resolved;
        synchronized (store) {
            Optional<Alert> open = store.find(id);
            if (open.isEmpty()) {
                return; // evicted; nothing to resolve
            }
            resolved = open.get().resolve(clock.millis(), sig.detail());
            store.save(resolved);
        }
        out.add(new AlertEvent(AlertEvent.Type.RESOLVED, resolved));
    }
}
