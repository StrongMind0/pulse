package dev.pulse.rules.domain;

/**
 * An alert instance. Immutable: every state change produces a new value, so
 * a snapshot handed to the API or MQTT can never change underneath a reader.
 */
public record Alert(
        String id,
        String deviceId,
        String ruleId,
        String ruleName,
        Severity severity,
        State state,
        String message,
        double triggerValue,
        long firedAt,
        Long resolvedAt,
        Long acknowledgedAt,
        String acknowledgedBy) {

    public enum State { FIRING, RESOLVED }

    public Alert resolve(long at, String detail) {
        return new Alert(id, deviceId, ruleId, ruleName, severity, State.RESOLVED,
                message + " | resolved: " + detail, triggerValue, firedAt, at, acknowledgedAt, acknowledgedBy);
    }

    public Alert acknowledge(long at, String by) {
        return new Alert(id, deviceId, ruleId, ruleName, severity, state, message, triggerValue,
                firedAt, resolvedAt, at, by);
    }

    public boolean acknowledged() {
        return acknowledgedAt != null;
    }
}
