package dev.pulse.rules.config;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/** All tunables in one validated place; a bad value fails startup, not 3am. */
@Validated
@ConfigurationProperties(prefix = "pulse")
public record PulseProperties(Mqtt mqtt, @Min(100) long sweepIntervalMs, @Min(10) int maxResolvedAlerts) {

    public record Mqtt(@NotBlank String url, @NotBlank String clientId, @NotBlank String username, String password) {
    }
}
