package dev.pulse.rules.domain;

import java.util.Map;

/**
 * A validated telemetry reading as published by the ingest service on
 * {@code pulse/v1/internal/readings}. {@code ts} is trusted event time (the
 * ingest service replaces skewed device clocks).
 */
public record Reading(String deviceId, long seq, long ts, long receivedAt, Map<String, Double> metrics) {

    public Reading {
        metrics = metrics == null ? Map.of() : Map.copyOf(metrics);
    }

    public Double metric(String name) {
        return metrics.get(name);
    }
}
