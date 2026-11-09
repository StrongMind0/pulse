import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const ISSUER = "pulse-gateway";
const AUDIENCE = "pulse-dashboard";
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

interface Credential {
  salt: Buffer;
  hash: Buffer;
}

export interface Session {
  sub: string;
  exp: number;
}

/**
 * Operator authentication.
 *
 * Passwords are never kept in memory as plain text: the configured password
 * is hashed with scrypt at startup and compared in constant time. Unknown
 * users still pay the full hash cost so response timing does not reveal
 * which usernames exist.
 */
export class Authenticator {
  private readonly key: Uint8Array;
  private readonly dummy: Credential;

  private constructor(
    private readonly users: Map<string, Credential>,
    secret: string,
  ) {
    this.key = new TextEncoder().encode(secret);
    this.dummy = { salt: randomBytes(16), hash: randomBytes(64) };
  }

  static async create(users: Record<string, string>, secret: string): Promise<Authenticator> {
    const map = new Map<string, Credential>();
    for (const [user, password] of Object.entries(users)) {
      const salt = randomBytes(16);
      map.set(user, { salt, hash: await scrypt(password, salt, 64) });
    }
    return new Authenticator(map, secret);
  }

  async checkPassword(user: string, password: string): Promise<boolean> {
    const cred = this.users.get(user) ?? this.dummy;
    const attempt = await scrypt(password, cred.salt, 64);
    return timingSafeEqual(attempt, cred.hash) && this.users.has(user);
  }

  async issue(sub: string): Promise<{ token: string; expiresAt: number }> {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: exp * 1000 };
  }

  /** Returns the session, or null for any invalid, expired or tampered token. */
  async verify(token: string): Promise<Session | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"], // never accept "none" or an attacker-chosen algorithm
      });
      if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
      return { sub: payload.sub, exp: payload.exp };
    } catch {
      return null;
    }
  }
}

/**
 * Brute-force protection: after `maxFailures` failed logins within `windowMs`
 * a key (client IP) is locked out until the window passes.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.failures.set(key, list);
    if (this.failures.size > 10_000) this.prune(); // bound memory under a distributed attack
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    return (this.failures.get(key) ?? []).filter((t) => t > cutoff);
  }

  private prune(): void {
    for (const key of this.failures.keys()) {
      const r = this.recent(key);
      if (r.length === 0) this.failures.delete(key);
      else this.failures.set(key, r);
    }
  }
}
