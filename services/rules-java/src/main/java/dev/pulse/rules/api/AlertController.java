package dev.pulse.rules.api;

import dev.pulse.rules.domain.Alert;
import dev.pulse.rules.domain.AlertEngine;
import dev.pulse.rules.domain.AlertStore;
import dev.pulse.rules.domain.Rule;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
@RequestMapping("/api/v1")
public class AlertController {

    private final AlertStore store;
    private final AlertEngine engine;

    public AlertController(AlertStore store, AlertEngine engine) {
        this.store = store;
        this.engine = engine;
    }

    public record AckRequest(@NotBlank @Size(max = 64) String by) {
    }

    @GetMapping("/alerts")
    public Map<String, Object> list(
            @RequestParam(required = false) Alert.State state,
            @RequestParam(required = false) @Pattern(regexp = "^[a-z0-9][a-z0-9-]{1,62}$") String deviceId,
            @RequestParam(defaultValue = "100") @Min(1) @Max(1000) int limit) {
        List<Alert> alerts = store.list(state, deviceId, limit);
        return Map.of("alerts", alerts, "firing", store.firingCount());
    }

    @GetMapping("/alerts/{id}")
    public Alert get(@PathVariable String id) {
        return store.find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "alert not found"));
    }

    @PostMapping("/alerts/{id}/ack")
    public Alert acknowledge(@PathVariable String id, @Valid @RequestBody AckRequest body) {
        return engine.acknowledge(id, body.by())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "alert not found"));
    }

    @GetMapping("/rules")
    public Map<String, List<Rule>> rules() {
        return Map.of("rules", engine.rules());
    }
}
