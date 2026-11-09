package dev.pulse.rules.config;

import dev.pulse.rules.domain.AlertEngine;
import dev.pulse.rules.domain.AlertEvent;
import dev.pulse.rules.domain.AlertStore;
import dev.pulse.rules.domain.DefaultRules;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;

@Configuration
public class EngineConfig {

    private static final Logger log = LoggerFactory.getLogger(EngineConfig.class);

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    AlertStore alertStore(PulseProperties props) {
        return new AlertStore(props.maxResolvedAlerts());
    }

    @Bean
    AlertEventBus alertEventBus(MeterRegistry registry) {
        AlertEventBus bus = new AlertEventBus();
        bus.subscribe(e -> Counter.builder("pulse_rules_alert_events")
                .description("Alert lifecycle events")
                .tag("type", e.type().name())
                .tag("rule", e.alert().ruleId())
                .tag("severity", e.alert().severity().name())
                .register(registry)
                .increment());
        bus.subscribe(EngineConfig::logEvent);
        return bus;
    }

    @Bean
    AlertEngine alertEngine(AlertStore store, Clock clock, AlertEventBus bus, MeterRegistry registry) {
        AlertEngine engine = new AlertEngine(DefaultRules.all(), store, clock, bus);
        Gauge.builder("pulse_rules_alerts_firing", store, AlertStore::firingCount)
                .description("Alerts currently firing").register(registry);
        Gauge.builder("pulse_rules_devices_tracked", engine, AlertEngine::trackedDevices).register(registry);
        Gauge.builder("pulse_rules_readings_evaluated", engine, AlertEngine::evaluatedCount)
                .description("Readings evaluated since start").register(registry);
        Gauge.builder("pulse_rules_readings_out_of_order", engine, AlertEngine::outOfOrderCount)
                .description("Readings skipped because they arrived older than the newest seen").register(registry);
        return engine;
    }

    @Bean
    SilenceSweeper silenceSweeper(AlertEngine engine) {
        return new SilenceSweeper(engine);
    }

    private static void logEvent(AlertEvent e) {
        var a = e.alert();
        switch (e.type()) {
            case FIRED -> log.warn("ALERT FIRED [{}] {} on {}: {}", a.severity(), a.ruleName(), a.deviceId(), a.message());
            case RESOLVED -> log.info("alert resolved: {} on {}", a.ruleName(), a.deviceId());
            case ACKNOWLEDGED -> log.info("alert acknowledged by {}: {} on {}", a.acknowledgedBy(), a.ruleName(), a.deviceId());
        }
    }

    /** Detects silent devices; runs on Spring's scheduler thread. */
    public static class SilenceSweeper {
        private final AlertEngine engine;

        SilenceSweeper(AlertEngine engine) {
            this.engine = engine;
        }

        @Scheduled(fixedDelayString = "${pulse.sweep-interval-ms}")
        public void sweep() {
            engine.sweep();
        }
    }
}
