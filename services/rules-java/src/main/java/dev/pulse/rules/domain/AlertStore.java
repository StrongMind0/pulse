package dev.pulse.rules.domain;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Optional;

/**
 * In-memory alert store. Firing alerts are always kept; resolved alerts are
 * capped (oldest evicted first) so memory stays bounded however long the
 * service runs.
 *
 * <p>Phase 1 trade-off: a restart forgets alert history and re-fires anything
 * still wrong. The interface is small enough to back with Postgres later.
 */
public final class AlertStore {

    private final int maxResolved;
    private final LinkedHashMap<String, Alert> alerts = new LinkedHashMap<>();
    private int resolved;

    public AlertStore(int maxResolved) {
        this.maxResolved = maxResolved;
    }

    public synchronized void save(Alert alert) {
        Alert prev = alerts.put(alert.id(), alert);
        if (prev != null && prev.state() == Alert.State.RESOLVED) {
            resolved--;
        }
        if (alert.state() == Alert.State.RESOLVED) {
            resolved++;
        }
        Iterator<Alert> it = alerts.values().iterator();
        while (resolved > maxResolved && it.hasNext()) {
            if (it.next().state() == Alert.State.RESOLVED) {
                it.remove();
                resolved--;
            }
        }
    }

    public synchronized Optional<Alert> find(String id) {
        return Optional.ofNullable(alerts.get(id));
    }

    /** Newest first. Null filters match everything. */
    public synchronized List<Alert> list(Alert.State state, String deviceId, int limit) {
        List<Alert> all = new ArrayList<>(alerts.values());
        List<Alert> out = new ArrayList<>();
        for (int i = all.size() - 1; i >= 0 && out.size() < limit; i--) {
            Alert a = all.get(i);
            if ((state == null || a.state() == state) && (deviceId == null || a.deviceId().equals(deviceId))) {
                out.add(a);
            }
        }
        return out;
    }

    public synchronized int firingCount() {
        return alerts.size() - resolved;
    }

    public synchronized int size() {
        return alerts.size();
    }
}
