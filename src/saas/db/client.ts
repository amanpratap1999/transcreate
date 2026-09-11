import type { TenantContext } from "../models.js";
import pg from "pg";
import { ConfigurationError } from "../config.js";

const { Pool } = pg;

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  withTenantTransaction<T>(
    orgId: string,
    callback: (tx: IDatabaseClient) => Promise<T>
  ): Promise<T>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresRlsViolationError extends Error {
  constructor(message = "Row Level Security violation: attempted access across tenant boundaries") {
    super(message);
    this.name = "PostgresRlsViolationError";
  }
}

/**
 * Real PostgreSQL client wrapper using pg.Pool.
 *
 * RLS isolation model:
 *  - The application connects as a NON-superuser role (`transcreate_app`).
 *  - Every tenant operation runs inside withTenantTransaction():
 *      BEGIN; SET LOCAL app.current_org_id = $1; ... COMMIT/ROLLBACK
 *  - SET LOCAL is transaction-scoped: pooled connections can NEVER retain
 *    tenant context after COMMIT/ROLLBACK.
 *  - RLS policies are the SECOND independent boundary (first: repository
 *    tenant assertions). Schema uses FORCE ROW LEVEL SECURITY.
 */
export class RealPostgreSqlDatabaseClient implements IDatabaseClient {
  private pool: pg.Pool;
  private connectionString?: string;

  constructor(connectionString: string, poolOptions: Partial<pg.PoolConfig> = {}) {
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString,
      // RLS correctness: a checked-out client must never auto-release mid-transaction
      max: poolOptions.max ?? 10,
      idleTimeoutMillis: poolOptions.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: poolOptions.connectionTimeoutMillis ?? 5_000,
      // Application role must not be superuser; assert after first connect (see assertNonSuperuser)
      ...(poolOptions as any)
    });
    this.pool.on("error", (err) => {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "ERROR",
          message: "PostgreSQL pool error",
          context: { code: (err as any)?.code, message: err.message }
        }) + "\n"
      );
    });
  }

  public getConnectionString(): string | undefined {
    return this.connectionString;
  }

  public async isHealthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1;");
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Verifies the connection role cannot bypass RLS (defense in depth against
   * misconfigured superuser/app role grants). Integration tests assert this too.
   */
  public async assertNonSuperuserAndRlsEnforced(): Promise<void> {
    const res = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    const row = res.rows[0];
    if (!row) throw new Error("current_user role not found");
    if (row.rolsuper || row.rolbypassrls) {
      throw new PostgresRlsViolationError(
        `Database role "${(await this.pool.query("SELECT current_user")).rows[0].current_user}" is superuser or has BYPASSRLS — tenant RLS isolation is void. Use a non-privileged app role.`
      );
    }
  }

  public async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount || 0 };
  }

  public async withTenantTransaction<T>(
    orgId: string,
    callback: (tx: IDatabaseClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();

    const txAdapter: IDatabaseClient = {
      query: async (sql, params) => {
        const res = await client.query(sql, params);
        return { rows: res.rows, rowCount: res.rowCount || 0 };
      },
      withTenantTransaction: async () => { throw new Error("Nested transactions unsupported"); },
      isHealthy: async () => true,
      close: async () => {}
    };

    try {
      await client.query("BEGIN;");
      await client.query("SET LOCAL app.current_org_id = $1;", [orgId]);
      const result = await callback(txAdapter);
      await client.query("COMMIT;");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK;");
      } catch {
        // connection already broken; release below discards it
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

function assertFakeAllowed(name: string): void {
  if ((process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new ConfigurationError(
      `Production integrity violation: attempted to construct in-memory fake "${name}". Production requires DATABASE_URL and the real PostgreSQL client.`
    );
  }
}

/**
 * In-memory fake for TESTS ONLY (explicitly injected). Never constructed from
 * ambient environment: createDatabaseClient() now REQUIRES an explicit URL.
 */
export class InMemoryPostgreSqlDatabaseClient implements IDatabaseClient {
  private currentOrgSession?: string;
  private tables = new Map<string, Array<{ org_id?: string; [key: string]: any }>>();

  public setTenantSession(orgId: string): void {
    this.currentOrgSession = orgId;
  }

  public clearTenantSession(): void {
    this.currentOrgSession = undefined;
  }

  public async isHealthy(): Promise<boolean> { return true; }
  public async close(): Promise<void> { this.currentOrgSession = undefined; }

  public async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const trimmed = sql.trim().toLowerCase();

    if (trimmed.startsWith("set local app.current_org_id")) {
      const match = sql.match(/set\s+local\s+app\.current_org_id\s*=\s*['"]?([^'"]+)['"]?/i);
      if (match) this.currentOrgSession = match[1];
      return { rows: [], rowCount: 0 };
    }

    const tableMatch = sql.match(/(?:from|into|update|delete from)\s+([a-z_]+)/i);
    const tableName = tableMatch ? tableMatch[1].toLowerCase() : "default";

    let tableRows = this.tables.get(tableName);
    if (!tableRows) {
      tableRows = [];
      this.tables.set(tableName, tableRows);
    }

    if (trimmed.startsWith("select")) {
      const activeOrg = this.currentOrgSession;
      if (!activeOrg) return { rows: [], rowCount: 0 };
      const filtered = tableRows.filter(r => !r.org_id || r.org_id === activeOrg);
      return { rows: filtered as T[], rowCount: filtered.length };
    }

    if (trimmed.startsWith("insert into")) {
      const activeOrg = this.currentOrgSession;
      const record = params[0] || {};
      if (record.org_id && activeOrg && record.org_id !== activeOrg) {
        throw new PostgresRlsViolationError(
          `PostgreSQL RLS INSERT blocked: record org_id "${record.org_id}" does not match "${activeOrg}"`
        );
      }
      tableRows.push({ ...record, org_id: record.org_id || activeOrg });
      return { rows: [record as T], rowCount: 1 };
    }

    if (trimmed.startsWith("delete")) {
      const activeOrg = this.currentOrgSession;
      if (!activeOrg) return { rows: [], rowCount: 0 };
      const initialCount = tableRows.length;
      const remaining = tableRows.filter(r => r.org_id !== activeOrg);
      this.tables.set(tableName, remaining);
      return { rows: [], rowCount: initialCount - remaining.length };
    }

    return { rows: [], rowCount: 0 };
  }

  public async withTenantTransaction<T>(
    orgId: string,
    callback: (tx: IDatabaseClient) => Promise<T>
  ): Promise<T> {
    await this.query("BEGIN;");
    await this.query(`SET LOCAL app.current_org_id = '${orgId}';`);
    try {
      const result = await callback(this);
      await this.query("COMMIT;");
      return result;
    } catch (err) {
      await this.query("ROLLBACK;");
      throw err;
    } finally {
      this.clearTenantSession();
    }
  }
}

// Backward-compatibility alias for existing tests; still test-only.
export class PostgreSqlDatabaseClient extends InMemoryPostgreSqlDatabaseClient {
  constructor() {
    super();
  }
}
