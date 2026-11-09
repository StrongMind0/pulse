package dev.pulse.rules.domain;

/** A change worth telling the world about: published on {@code pulse/v1/internal/alerts}. */
public record AlertEvent(Type type, Alert alert) {

    public enum Type { FIRED, RESOLVED, ACKNOWLEDGED }
}
