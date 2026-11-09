package dev.pulse.rules.domain;

import java.util.List;

/**
 * The rule set shipped with Phase 1. Limits are tuned to the simulator's
 * device models: normal operation never trips them, injected faults do.
 */
public final class DefaultRules {

    private DefaultRules() {
    }

    public static List<Rule> all() {
        return List.of(
                new Rule.Threshold("pump-overheat", "Pump overheating", Severity.CRITICAL, "pump-", 3_000,
                        "temperature_c", 75, 70),
                new Rule.Threshold("motor-overheat", "Motor overheating", Severity.CRITICAL, "motor-", 3_000,
                        "temperature_c", 85, 80),
                new Rule.Threshold("room-too-hot", "Room too hot", Severity.WARNING, "env-", 5_000,
                        "temperature_c", 35, 32),
                new Rule.RateOfChange("temp-rising-fast", "Temperature rising fast", Severity.WARNING, "", 0,
                        "temperature_c", 0.8, 10_000),
                new Rule.Threshold("high-vibration", "High vibration (bearing wear?)", Severity.WARNING, "", 2_000,
                        "vibration_g", 0.3, 0.15),
                new Rule.Flatline("sensor-stuck", "Sensor stuck", Severity.WARNING, "", 0, 10),
                new Rule.Silence("device-silent", "Device silent", Severity.CRITICAL, "", 0, 15_000));
    }
}
