const UNITS: Record<string, { label: string; unit: string; digits: number }> = {
  temperature_c: { label: "Temperature", unit: "°C", digits: 1 },
  humidity_pct: { label: "Humidity", unit: "%", digits: 0 },
  pressure_bar: { label: "Pressure", unit: "bar", digits: 2 },
  vibration_g: { label: "Vibration", unit: "g", digits: 2 },
  current_a: { label: "Current", unit: "A", digits: 1 },
};

export function metricInfo(name: string) {
  return UNITS[name] ?? { label: name.replace(/_/g, " "), unit: "", digits: 2 };
}

export function formatMetric(name: string, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "–";
  const m = metricInfo(name);
  return `${v.toFixed(m.digits)}${m.unit ? (m.unit === "%" || m.unit === "°C" ? "" : " ") + m.unit : ""}`;
}

/** Orders a device's metrics so the most telling one comes first. */
export function sortMetrics(names: string[]): string[] {
  const order = Object.keys(UNITS);
  return [...names].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

export function deviceKind(id: string): string {
  return id.split("-")[0] ?? id;
}

export function relativeTime(at: number | null | undefined, now: number): string {
  if (!at || !now) return "–";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function clockTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
