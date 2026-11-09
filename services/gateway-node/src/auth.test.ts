import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { Authenticator, LoginRateLimiter } from "./auth.js";

const SECRET = "x".repeat(32);

describe("Authenticator", () => {
  it("accepts the right password and rejects wrong ones and unknown users", async () => {
    const auth = await Authenticator.create({ admin: "correct horse" }, SECRET);
    expect(await auth.checkPassword("admin", "correct horse")).toBe(true);
    expect(await auth.checkPassword("admin", "wrong")).toBe(false);
    expect(await auth.checkPassword("mallory", "correct horse")).toBe(false);
  });

  it("issues tokens that verify, and rejects tampered ones", async () => {
    const auth = await Authenticator.create({ admin: "pw-123456" }, SECRET);
    const { token } = await auth.issue("admin");
    expect((await auth.verify(token))?.sub).toBe("admin");

    const [h, p, s] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "root", exp: 9999999999 })).toString("base64url");
    expect(await auth.verify(`${h}.${forgedPayload}.${s}`)).toBeNull();
    expect(await auth.verify(`${h}.${p}.${s}x`)).toBeNull();
    expect(await auth.verify("garbage")).toBeNull();
  });

  it("rejects tokens signed with another key, expired, or for another audience", async () => {
    const auth = await Authenticator.create({ admin: "pw-123456" }, SECRET);
    const other = await Authenticator.create({ admin: "pw-123456" }, "y".repeat(32));
    expect(await auth.verify((await other.issue("admin")).token)).toBeNull();

    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("admin")
      .setIssuer("pulse-gateway").setAudience("pulse-dashboard").setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key);
    expect(await auth.verify(expired)).toBeNull();

    const wrongAud = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("admin")
      .setIssuer("pulse-gateway").setAudience("someone-else").setExpirationTime("1h").sign(key);
    expect(await auth.verify(wrongAud)).toBeNull();
  });

  it("rejects alg=none tokens", async () => {
    const auth = await Authenticator.create({ admin: "pw-123456" }, SECRET);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none" })}.${enc({ sub: "admin", iss: "pulse-gateway", aud: "pulse-dashboard", exp: 9999999999 })}.`;
    expect(await auth.verify(none)).toBeNull();
  });
});

describe("LoginRateLimiter", () => {
  it("locks a key after repeated failures and unlocks after the window", () => {
    let now = 0;
    const rl = new LoginRateLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) rl.recordFailure("1.2.3.4");
    expect(rl.isLocked("1.2.3.4")).toBe(true);
    expect(rl.isLocked("5.6.7.8")).toBe(false);
    now = 61_000;
    expect(rl.isLocked("1.2.3.4")).toBe(false);
  });

  it("reset clears failures after a successful login", () => {
    const rl = new LoginRateLimiter(2, 60_000);
    rl.recordFailure("ip");
    rl.reset("ip");
    rl.recordFailure("ip");
    expect(rl.isLocked("ip")).toBe(false);
  });
});
