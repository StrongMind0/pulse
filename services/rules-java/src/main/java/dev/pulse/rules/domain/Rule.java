package dev.pulse.rules.domain;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * A detection rule. Rules are pure functions of a device's recent readings;
 * all state (pending/firing, timers, de-duplication) lives in {@link AlertEngine}.
 */
public sealed interface Rule
        permits Rule.Threshold, Rule.RateOfChange, Rule.Flatline, Rule.Silence {

    String id();

    String name();

    Severity severity();

    /** Device id prefix this rule applies to, e.g. {@code "pump-"}; empty means all devices. */
    String devicePrefix();

    /** How long the trigger must hold continuously before the alert fires (0 = immediately). */
    long forMillis();

    @JsonProperty("type")
    default String type() {
        return getClass().getSimpleName().toLowerCase(Locale.ROOT);
    }

    default boolean appliesTo(String deviceId) {
        return devicePrefix().isEmpty() || deviceId.startsWith(devicePrefix());
    }

    /** Evaluate against a device's window, newest reading last. Empty = not enough data, change nothing. */
    Optional<Signal> evaluate(List<Reading> window);

    /** Fires when a metric is above {@code trigger}; clears once it drops below {@code clear}. */
    record Threshold(String id, String name, Severity severity, String devicePrefix, long forMillis,
                     String metric, double trigger, double clear) implements Rule {

        public Threshold {
            if (clear > trigger) {
                throw new IllegalArgumentException("clear must be <= trigger for rule " + id);
            }
        }

        @Override
        public Optional<Signal> evaluate(List<Reading> window) {
            Double v = window.getLast().metric(metric);
            if (v == null) {
                return Optional.empty();
            }
            String d = String.format(Locale.ROOT, "%s is %.2f (limit %.2f)", metric, v, trigger);
            if (v > trigger) {
                return Optional.of(Signal.firing(v, d));
            }
            return Optional.of(v < clear ? Signal.cleared(v, d) : Signal.holding(v, d));
        }
    }

    /**
     * Fires when a metric rises faster than {@code maxPerSecond} across the
     * window. Catches an overheating pump while it is still below the hard limit.
     */
    record RateOfChange(String id, String name, Severity severity, String devicePrefix, long forMillis,
                        String metric, double maxPerSecond, long windowMillis) implements Rule {

        @Override
        public Optional<Signal> evaluate(List<Reading> window) {
            Reading last = window.getLast();
            Reading first = null;
            int samples = 0;
            for (Reading r : window) {
                if (r.metric(metric) != null && last.ts() - r.ts() <= windowMillis) {
                    if (first == null) {
                        first = r;
                    }
                    samples++;
                }
            }
            if (first == null || last.metric(metric) == null || samples < 3) {
                return Optional.empty();
            }
            long span = last.ts() - first.ts();
            if (span < windowMillis / 2) {
                return Optional.empty(); // too little history to call it a trend
            }
            double rate = (last.metric(metric) - first.metric(metric)) / (span / 1000.0);
            String d = String.format(Locale.ROOT, "%s rising %.2f/s (limit %.2f/s)", metric, rate, maxPerSecond);
            if (rate > maxPerSecond) {
                return Optional.of(Signal.firing(rate, d));
            }
            return Optional.of(rate < maxPerSecond / 2 ? Signal.cleared(rate, d) : Signal.holding(rate, d));
        }
    }

    /**
     * Fires when any metric reports the exact same value {@code samples} times
     * in a row. Real sensors are noisy; a perfectly flat line is a frozen sensor.
     */
    record Flatline(String id, String name, Severity severity, String devicePrefix, long forMillis,
                    int samples) implements Rule {

        @Override
        public Optional<Signal> evaluate(List<Reading> window) {
            if (window.size() < samples) {
                return Optional.empty();
            }
            List<Reading> recent = window.subList(window.size() - samples, window.size());
            List<String> stuck = new ArrayList<>();
            for (String metric : window.getLast().metrics().keySet()) {
                Double first = recent.getFirst().metric(metric);
                if (first != null && recent.stream().allMatch(r -> first.equals(r.metric(metric)))) {
                    stuck.add(metric);
                }
            }
            if (!stuck.isEmpty()) {
                stuck.sort(null);
                String m = stuck.getFirst();
                return Optional.of(Signal.firing(window.getLast().metric(m),
                        "%s unchanged for %d readings (sensor stuck?)".formatted(String.join(", ", stuck), samples)));
            }
            return Optional.of(Signal.cleared(0, "sensor values changing"));
        }
    }

    /**
     * Fires when a device stops sending. Evaluated by the engine's periodic
     * sweep rather than per reading, since the whole point is that no reading arrives.
     */
    record Silence(String id, String name, Severity severity, String devicePrefix, long forMillis,
                   long timeoutMillis) implements Rule {

        @Override
        public Optional<Signal> evaluate(List<Reading> window) {
            return Optional.of(Signal.cleared(0, "device reporting"));
        }

        public Signal check(long silentForMillis) {
            String d = "no data for %ds (limit %ds)".formatted(silentForMillis / 1000, timeoutMillis / 1000);
            return silentForMillis > timeoutMillis ? Signal.firing(silentForMillis / 1000.0, d) : Signal.holding(0, d);
        }
    }
}
