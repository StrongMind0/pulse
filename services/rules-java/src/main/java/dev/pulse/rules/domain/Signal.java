package dev.pulse.rules.domain;

/**
 * What a rule concluded about the latest data.
 *
 * <p>{@code trigger} and {@code clear} are deliberately separate conditions
 * (hysteresis): an alert that fires above 80 C and clears below 75 C does not
 * flap on and off when the value hovers around 80.
 *
 * @param trigger the firing condition holds
 * @param clear   the recovery condition holds
 * @param value   the value that was evaluated, for the alert message
 * @param detail  human-readable explanation
 */
public record Signal(boolean trigger, boolean clear, double value, String detail) {

    public static Signal firing(double value, String detail) {
        return new Signal(true, false, value, detail);
    }

    public static Signal cleared(double value, String detail) {
        return new Signal(false, true, value, detail);
    }

    /** Neither firing nor clearly recovered: the in-between hysteresis band. */
    public static Signal holding(double value, String detail) {
        return new Signal(false, false, value, detail);
    }
}
