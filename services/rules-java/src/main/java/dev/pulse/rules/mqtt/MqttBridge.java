package dev.pulse.rules.mqtt;

import dev.pulse.rules.config.AlertEventBus;
import dev.pulse.rules.config.PulseProperties;
import dev.pulse.rules.domain.AlertEngine;
import dev.pulse.rules.domain.AlertEvent;
import dev.pulse.rules.domain.Reading;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.charset.StandardCharsets;
import org.eclipse.paho.client.mqttv3.IMqttActionListener;
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.IMqttToken;
import org.eclipse.paho.client.mqttv3.MqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttException;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Connects the engine to the broker: consumes validated readings, publishes
 * alert events. Paho's automatic reconnect handles broker restarts; the
 * subscription is re-established in {@link #connectComplete} because the
 * session is clean.
 */
@Component
public class MqttBridge implements SmartLifecycle, MqttCallbackExtended, HealthIndicator {

    public static final String READINGS_TOPIC = "pulse/v1/internal/readings";
    public static final String ALERTS_TOPIC = "pulse/v1/internal/alerts";

    private static final Logger log = LoggerFactory.getLogger(MqttBridge.class);

    private final PulseProperties.Mqtt cfg;
    private final AlertEngine engine;
    private final JsonMapper json;
    private final Counter received;
    private final Counter malformed;
    private final Counter publishFailures;
    private MqttAsyncClient client;
    private volatile boolean running;

    public MqttBridge(PulseProperties props, AlertEngine engine, AlertEventBus bus, JsonMapper json, MeterRegistry registry) {
        this.cfg = props.mqtt();
        this.engine = engine;
        this.json = json;
        this.received = Counter.builder("pulse_rules_mqtt_received").register(registry);
        this.malformed = Counter.builder("pulse_rules_mqtt_malformed").register(registry);
        this.publishFailures = Counter.builder("pulse_rules_mqtt_publish_failures").register(registry);
        bus.subscribe(this::publish);
    }

    @Override
    public void start() {
        try {
            client = new MqttAsyncClient(cfg.url(), cfg.clientId(), new MemoryPersistence());
            client.setCallback(this);
            MqttConnectOptions opts = new MqttConnectOptions();
            opts.setUserName(cfg.username());
            if (cfg.password() != null) {
                opts.setPassword(cfg.password().toCharArray());
            }
            opts.setCleanSession(true);
            opts.setAutomaticReconnect(true);
            opts.setMaxReconnectDelay(10_000);
            opts.setKeepAliveInterval(30);
            opts.setConnectionTimeout(5);
            running = true;
            connect(opts);
        } catch (MqttException e) {
            throw new IllegalStateException("cannot create MQTT client", e);
        }
    }

    /** First connect: Paho only auto-reconnects after an initial success, so retry ourselves until then. */
    private void connect(MqttConnectOptions opts) {
        try {
            client.connect(opts, null, new IMqttActionListener() {
                @Override
                public void onSuccess(IMqttToken token) {
                    // subscription happens in connectComplete
                }

                @Override
                public void onFailure(IMqttToken token, Throwable e) {
                    log.warn("MQTT connect to {} failed ({}), retrying in 2s", cfg.url(), e.getMessage());
                    if (running) {
                        Thread.ofVirtual().start(() -> {
                            sleep(2000);
                            if (running) {
                                connect(opts);
                            }
                        });
                    }
                }
            });
        } catch (MqttException e) {
            log.error("MQTT connect error", e);
        }
    }

    @Override
    public void connectComplete(boolean reconnect, String serverURI) {
        log.info("MQTT {} to {}", reconnect ? "reconnected" : "connected", serverURI);
        try {
            client.subscribe(READINGS_TOPIC, 0);
        } catch (MqttException e) {
            log.error("subscribe failed", e);
        }
    }

    @Override
    public void connectionLost(Throwable cause) {
        log.warn("MQTT connection lost: {}", cause == null ? "unknown" : cause.getMessage());
    }

    @Override
    public void messageArrived(String topic, MqttMessage message) {
        received.increment();
        Reading r;
        try {
            r = json.readValue(message.getPayload(), Reading.class);
        } catch (JacksonException e) {
            malformed.increment();
            log.debug("malformed reading: {}", e.getOriginalMessage());
            return;
        }
        if (r.deviceId() == null) {
            malformed.increment();
            return;
        }
        // Never let one bad evaluation kill Paho's callback thread.
        try {
            engine.onReading(r);
        } catch (RuntimeException e) {
            log.error("rule evaluation failed for {}", r.deviceId(), e);
        }
    }

    @Override
    public void deliveryComplete(IMqttDeliveryToken token) {
    }

    private void publish(AlertEvent event) {
        if (client == null || !client.isConnected()) {
            publishFailures.increment(); // alert is still in the store and visible via REST
            return;
        }
        try {
            byte[] body = json.writeValueAsString(event).getBytes(StandardCharsets.UTF_8);
            client.publish(ALERTS_TOPIC, body, 1, false);
        } catch (MqttException | JacksonException e) {
            publishFailures.increment();
            log.error("failed to publish alert event", e);
        }
    }

    @Override
    public Health health() {
        return client != null && client.isConnected()
                ? Health.up().withDetail("broker", cfg.url()).build()
                : Health.down().withDetail("broker", cfg.url()).build();
    }

    @Override
    public void stop() {
        running = false;
        if (client != null) {
            try {
                if (client.isConnected()) {
                    client.disconnect(2000).waitForCompletion(3000);
                }
                client.close();
            } catch (MqttException e) {
                log.warn("MQTT shutdown: {}", e.getMessage());
            }
        }
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
