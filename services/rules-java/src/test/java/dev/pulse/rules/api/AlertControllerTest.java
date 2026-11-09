package dev.pulse.rules.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.pulse.rules.domain.AlertEngine;
import dev.pulse.rules.domain.AlertStore;
import dev.pulse.rules.domain.DefaultRules;
import dev.pulse.rules.domain.Reading;
import java.time.Clock;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/** HTTP contract tests: routing, validation and status codes, with no broker needed. */
class AlertControllerTest {

    AlertEngine engine;
    MockMvc mvc;

    @BeforeEach
    void setUp() {
        AlertStore store = new AlertStore(100);
        engine = new AlertEngine(DefaultRules.all(), store, Clock.systemUTC(), e -> { });
        mvc = MockMvcBuilders.standaloneSetup(new AlertController(store, engine)).build();
    }

    String fireOne() {
        long t = 0;
        for (int i = 0; i < 6; i++) {
            engine.onReading(new Reading("pump-01", i, t += 1_000, t, Map.of("temperature_c", 99.0)));
        }
        return engine.rules().isEmpty() ? null : mvcFirstAlertId();
    }

    String mvcFirstAlertId() {
        try {
            String body = mvc.perform(get("/api/v1/alerts")).andReturn().getResponse().getContentAsString();
            int i = body.indexOf("\"id\":\"") + 6;
            return body.substring(i, body.indexOf('"', i));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void listsFiringAlerts() throws Exception {
        fireOne();
        mvc.perform(get("/api/v1/alerts").param("state", "FIRING"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firing").value(1))
                .andExpect(jsonPath("$.alerts[0].deviceId").value("pump-01"))
                .andExpect(jsonPath("$.alerts[0].ruleId").value("pump-overheat"));
    }

    @Test
    void acknowledgesAnAlert() throws Exception {
        String id = fireOne();
        mvc.perform(post("/api/v1/alerts/{id}/ack", id).contentType(MediaType.APPLICATION_JSON).content("{\"by\":\"oncall\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.acknowledgedBy").value("oncall"));
    }

    @Test
    void rejectsBadInput() throws Exception {
        String id = fireOne();
        mvc.perform(post("/api/v1/alerts/{id}/ack", id).contentType(MediaType.APPLICATION_JSON).content("{\"by\":\"\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/alerts").param("state", "EXPLODED"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void unknownAlertIs404() throws Exception {
        mvc.perform(get("/api/v1/alerts/nope")).andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/alerts/nope/ack").contentType(MediaType.APPLICATION_JSON).content("{\"by\":\"x\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void exposesRules() throws Exception {
        mvc.perform(get("/api/v1/rules"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.rules[0].id").value("pump-overheat"))
                .andExpect(jsonPath("$.rules[0].type").value("threshold"));
    }
}
