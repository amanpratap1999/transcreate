import * as crypto from "node:crypto";
import { ConfigurationError, KNOWN_INSECURE_SECRETS } from "./config.js";
import type { Role, TenantContext, User, Membership } from "./models.js";
import { getSharedRedis, type SharedRedisHandle } from "./redis.js";

export const TOKEN_EXPIRY_SECONDS = 24 * 3600; // 24h access token
export const REFRESH_WINDOW_SECONDS = 7 * 24 * 3600; // session row lifetime

export interface AuthSession {
  jti: string;
  userId: string;
  orgId: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

/**
 * The JWT signing secret. There is NO usable default anymore:
 *  - production: throws when missing/weak/known-dev constant (fail closed)
 *  - development/test: a random per-process secret (never a public constant)
 */
export function resolveJwtSecret(): string {
  const raw = process.env.JWT_SECRET;
  const isProduction = (process.env.NODE_ENV || "").toLowerCase() === "production";
  if (raw && raw.trim().length > 0) {
    const secret = raw.trim();
    if (isProduction) {
      if (KNOWN_INSECURE_SECRETS.has(secret)) {
        throw new ConfigurationError(
          "JWT_SECRET is set to a known development default — production refuses to boot with a public constant secret."
        );
      }
      if (secret.length < 32) {
        throw new ConfigurationError(`JWT_SECRET must be at least 32 characters in production (current: ${secret.length}).`);
      }
    }
    return secret;
  }
  if (isProduction) {
    throw new ConfigurationError("JWT_SECRET is required in production. Provide at least 32 random bytes.");
  }
  // Development/test: ephemeral random process secret
  return crypto.randomBytes(48).toString("hex");
}

export interface AuthSession {
  id: string;
  userId: string;
  orgId: string;
  role: Role;
  userAgent?: string;
  ipAddress?: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface AuthTokenPayload {
  sub: string;       // User ID
  email: string;
  orgId: string;     // Active Tenant Organization ID
  role: Role;        // User's verified role within this Org
  jti: string;       // Unique token/session ID
  iat: number;       // Issued at (unix seconds)
  exp: number;       // Expires at (unix seconds)
}

export class AuthenticationError extends Error {
  constructor(message = "Authentication required or invalid credentials") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class TokenExpiredError extends AuthenticationError {
  constructor() {
    super("Authentication token has expired");
    this.name = "TokenExpiredError";
  }
}

export class TokenRevokedError extends AuthenticationError {
  constructor() {
    super("Authentication session has been revoked");
    this.name = "TokenRevokedError";
  }
}

export class PasswordHasher {
  private static ITERATIONS = 100000;
  private static KEY_LENGTH = 64;
  private static DIGEST = "sha512";
  /** Fixed dummy hash so unknown-user login burns the same PBKDF2 time (timing equalization). */
  private static DUMMY_HASH: string | null = null;

  public static async hash(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, this.ITERATIONS, this.KEY_LENGTH, this.DIGEST, (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`pbkdf2$${this.DIGEST}$${this.ITERATIONS}$${salt}$${derivedKey.toString("hex")}`);
      });
    });
  }

  public static async verify(password: string, storedHash: string): Promise<boolean> {
    const parts = storedHash.split("$");
    if (parts.length !== 5 || parts[0] !== "pbkdf2") {
      return false;
    }
    const digest = parts[1];
    const iterations = parseInt(parts[2], 10);
    const salt = parts[3];
    const expectedKey = Buffer.from(parts[4], "hex");

    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, iterations, expectedKey.length, digest, (err, derivedKey) => {
        if (err) return reject(err);
        if (derivedKey.length !== expectedKey.length) return resolve(false);
        resolve(crypto.timingSafeEqual(derivedKey, expectedKey));
      });
    });
  }

  /** Always burns one PBKDF2 verification regardless of user existence (timing equalization). */
  public static async verifyAgainstDummy(password: string): Promise<void> {
    if (!this.DUMMY_HASH) {
      this.DUMMY_HASH = await this.hash("dummy-password-for-timing-equalization");
    }
    await this.verify(password, this.DUMMY_HASH);
  }
}

export interface ITokenRevocationStore {
  revoke(jti: string, ttlSeconds: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

/** Redis-backed revocation store — the production store. Uses the shared connection. */
export class RedisTokenRevocationStore implements ITokenRevocationStore {
  private handle: SharedRedisHandle;
  constructor(handle?: SharedRedisHandle) {
    this.handle = handle ?? getSharedRedis();
  }
  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.handle.client.set(`revoked:${jti}`, "1", "EX", ttlSeconds);
  }
  async isRevoked(jti: string): Promise<boolean> {
    return (await this.handle.client.get(`revoked:${jti}`)) !== null;
  }
}

function assertFakeAllowed(name: string): void {
  if ((process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new ConfigurationError(
      `Production integrity violation: attempted to construct in-memory fake "${name}".`
    );
  }
}

/** Test/development-only in-memory store. Forbidden in production. */
export class InMemoryTokenRevocationStore implements ITokenRevocationStore {
  private revoked = new Map<string, number>();
  constructor() {
    assertFakeAllowed("InMemoryTokenRevocationStore");
  }
  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    this.revoked.set(jti, Date.now() + ttlSeconds * 1000);
  }
  async isRevoked(jti: string): Promise<boolean> {
    const exp = this.revoked.get(jti);
    return exp !== undefined && exp > Date.now();
  }
}

export class TokenService {
  private secret: string;
  private revocation: ITokenRevocationStore;

  constructor(options: { secret?: string; revocation?: ITokenRevocationStore } = {}) {
    this.secret = options.secret ?? resolveJwtSecret();
    this.revocation = options.revocation ?? new InMemoryTokenRevocationStore();
  }

  private base64UrlEncode(input: string | Buffer): string {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf-8");
    return buffer.toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  private base64UrlDecode(base64url: string): string {
    let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    return Buffer.from(base64, "base64").toString("utf-8");
  }

  public generateToken(payload: Omit<AuthTokenPayload, "iat" | "exp" | "jti">, expirySeconds = TOKEN_EXPIRY_SECONDS): string {
    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const fullPayload: AuthTokenPayload = {
      ...payload,
      jti,
      iat: now,
      exp: now + expirySeconds
    };

    const header = { alg: "HS256", typ: "JWT" };
    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(fullPayload));

    const signature = crypto
      .createHmac("sha256", this.secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const encodedSignature = this.base64UrlEncode(signature);

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
  }

  public async verifyToken(token: string): Promise<AuthTokenPayload> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new AuthenticationError("Malformed JWT token structure");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const expectedSignature = this.base64UrlEncode(
      crypto
        .createHmac("sha256", this.secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest()
    );

    const sigBuf = Buffer.from(encodedSignature);
    const expBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new AuthenticationError("Invalid token signature");
    }

    let payload: AuthTokenPayload;
    try {
      payload = JSON.parse(this.base64UrlDecode(encodedPayload));
    } catch {
      throw new AuthenticationError("Invalid token payload JSON");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new TokenExpiredError();
    }

    const revoked = await this.revocation.isRevoked(payload.jti);
    if (revoked) {
      throw new TokenRevokedError();
    }

    return payload;
  }

  public async revokeToken(jti: string, expirySeconds = TOKEN_EXPIRY_SECONDS): Promise<void> {
    await this.revocation.revoke(jti, expirySeconds);
  }

  public getRevocationStore(): ITokenRevocationStore {
    return this.revocation;
  }
}

export class AuthenticationManager {
  private tokenService: TokenService;
  private usersByEmail = new Map<string, any>();
  private usersById = new Map<string, any>();
  private memberships = new Map<string, any>(); // key: \`\${orgId}:\${userId}\`

  constructor(tokenService?: TokenService) {
    this.tokenService = tokenService || new TokenService();
  }

  public async registerUser(
    email: string,
    password: string,
    name: string,
    orgId: string,
    role: any = "admin"
  ): Promise<{ user: any; token: string }> {
    const cleanEmail = email.toLowerCase().trim();
    if (this.usersByEmail.has(cleanEmail)) {
      throw new Error(`User with email "${cleanEmail}" already exists`);
    }

    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters long");
    }

    const passwordHash = await PasswordHasher.hash(password);
    const id = "usr_" + require("crypto").randomUUID().slice(0, 12);
    const user = {
      id,
      email: cleanEmail,
      name,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const userWithHash = { ...user, passwordHash };
    this.usersByEmail.set(cleanEmail, userWithHash);
    this.usersById.set(id, userWithHash);

    const membershipId = "mem_" + require("crypto").randomUUID().slice(0, 12);
    const membership = {
      id: membershipId,
      orgId,
      userId: id,
      role,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.memberships.set(`${orgId}:${id}`, membership);

    const token = this.tokenService.generateToken({
      sub: id,
      email: cleanEmail,
      orgId,
      role
    });

    return { user, token };
  }

  public async loginUser(
    email: string,
    password: string,
    orgId?: string
  ): Promise<{ user: any; token: string; activeOrgId: string; role: any }> {
    const cleanEmail = email.toLowerCase().trim();
    const user = this.usersByEmail.get(cleanEmail);
    if (!user) {
      throw new AuthenticationError("Invalid email or password");
    }

    const valid = await PasswordHasher.verify(password, user.passwordHash);
    if (!valid) {
      throw new AuthenticationError("Invalid email or password");
    }

    let activeMembership;
    if (orgId) {
      activeMembership = this.memberships.get(`${orgId}:${user.id}`);
      if (!activeMembership) {
        throw new AuthenticationError(`User is not a member of organization "${orgId}"`);
      }
    } else {
      for (const m of this.memberships.values()) {
        if (m.userId === user.id) {
          activeMembership = m;
          break;
        }
      }
    }

    if (!activeMembership) {
      throw new AuthenticationError("User does not belong to any active organization");
    }

    const token = this.tokenService.generateToken({
      sub: user.id,
      email: user.email,
      orgId: activeMembership.orgId,
      role: activeMembership.role
    });

    const safeUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return {
      user: safeUser,
      token,
      activeOrgId: activeMembership.orgId,
      role: activeMembership.role
    };
  }

  public addMembership(membership: any): void {
    this.memberships.set(`${membership.orgId}:${membership.userId}`, membership);
  }

  public async verifyRequest(authHeader?: string, cookieHeader?: string): Promise<any> {
    let token: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else if (cookieHeader) {
      const match = cookieHeader.match(/session=([^;]+)/);
      if (match) {
        token = match[1];
      }
    }

    if (!token) {
      throw new AuthenticationError("Missing required authorization token");
    }

    const payload = await this.tokenService.verifyToken(token);

    return {
      orgId: payload.orgId,
      userId: payload.sub,
      role: payload.role
    };
  }

  public async logout(token: string): Promise<void> {
    try {
      const payload = await this.tokenService.verifyToken(token);
      await this.tokenService.revokeToken(payload.jti);
    } catch {
    }
  }
}
