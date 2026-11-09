package dev.pulse.rules.config;

import dev.pulse.rules.domain.AlertEvent;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Fan-out from the engine to its listeners (MQTT, metrics, logs). Decouples
 * the engine from the MQTT client, which itself depends on the engine.
 * A failing listener is logged and never breaks the others.
 */
public final class AlertEventBus implements Consumer<AlertEvent> {

    private static final Logger log = LoggerFactory.getLogger(AlertEventBus.class);
    private final List<Consumer<AlertEvent>> listeners = new CopyOnWriteArrayList<>();

    public void subscribe(Consumer<AlertEvent> listener) {
        listeners.add(listener);
    }

    @Override
    public void accept(AlertEvent event) {
        for (Consumer<AlertEvent> l : listeners) {
            try {
                l.accept(event);
            } catch (RuntimeException e) {
                log.error("alert listener failed for {} {}", event.type(), event.alert().id(), e);
            }
        }
    }
}
