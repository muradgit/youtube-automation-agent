const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

const TIMESTAMP_COLUMNS = [
  'scheduled_publish_time', 'publish_time', 'published_at', 'analyzed_at',
  'measured_at', 'created_at', 'updated_at', 'reviewed_at', 'approved_at',
  'started_at', 'completed_at', 'adopted_at', 'cancelled_at', 'ended_at',
  'captured_at', 'updated_at_youtube', 'posted_at', 'last_synced_at',
  'newest_comment_at', 'narration_generated_at', 'rendered_at', 'publish_date',
  'last_used', 'scheduled_for'
];

/**
 * Build a Postgres-backed Database class while preserving the existing SQLite
 * implementation for local/self-hosted installs. The inherited domain methods
 * keep using executeQuery/getRow/getAllRows, which are translated here.
 */
function createPostgresDatabaseClass(SQLiteDatabase) {
  return class PostgresDatabase extends SQLiteDatabase {
    constructor() {
      super();
      this.pool = null;
      this.db = null;
      this.isPostgres = true;
      this.constraintCache = new Map();
      this.transactionStorage = new AsyncLocalStorage();
    }

    async initialize() {
      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required for the Postgres database adapter');
      }

      this.logger.info('Initializing Supabase Postgres database...');
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Math.max(1, Number.parseInt(process.env.DB_POOL_MAX || '3', 10)),
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        ssl: this.shouldUseSsl() ? { rejectUnauthorized: false } : false
      });
      this.db = this.pool;

      await this.pool.query('SELECT 1');
      await this.createTables();
      this.logger.success('Supabase Postgres database initialized successfully');
      return true;
    }

    shouldUseSsl() {
      if (process.env.DATABASE_SSL === 'false') return false;
      return !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
    }

    queryClient() {
      return this.transactionStorage.getStore() || this.pool;
    }

    async withTransaction(work) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await this.transactionStorage.run(client, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          this.logger.error(`Postgres rollback failed: ${rollbackError.message}`);
        }
        throw error;
      } finally {
        client.release();
      }
    }

    async saveDiscoverabilityAudit(...args) {
      return this.withTransaction(() => SQLiteDatabase.prototype.saveDiscoverabilityAudit.apply(this, args));
    }

    async ensureColumns(tableName, columns) {
      const allowedTables = new Set(['production_scenes', 'channel_strategies', 'discoverability_audits']);
      if (!allowedTables.has(tableName)) throw new Error(`Unsupported migration table: ${tableName}`);

      const result = await this.pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [tableName]
      );
      const existing = new Set(result.rows.map(row => row.column_name));

      for (const [columnName, definition] of Object.entries(columns)) {
        if (!existing.has(columnName)) {
          const normalized = columnName === 'narration_generated_at' ? 'TIMESTAMPTZ' : definition;
          await this.pool.query(`ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${this.quoteIdentifier(columnName)} ${normalized}`);
        }
      }
    }

    quoteIdentifier(value) {
      return `"${String(value).replace(/"/g, '""')}"`;
    }

    normalizeCreateTable(sql) {
      if (!/^CREATE\s+TABLE\b/i.test(sql)) return sql;
      let output = sql.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGSERIAL PRIMARY KEY');
      for (const column of TIMESTAMP_COLUMNS) {
        const matcher = new RegExp(`\\b${column}\\s+TEXT\\b`, 'gi');
        output = output.replace(matcher, `${column} TIMESTAMPTZ`);
      }
      return output;
    }

    normalizeSqliteDateFunctions(sql) {
      return sql
        .replace(/datetime\(\s*'now'\s*,\s*'-(\d+)\s+days?'\s*\)/gi, "CURRENT_TIMESTAMP - INTERVAL '$1 days'")
        .replace(/datetime\(\s*'now'\s*,\s*'-(\d+)\s+hours?'\s*\)/gi, "CURRENT_TIMESTAMP - INTERVAL '$1 hours'")
        .replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP')
        .replace(/datetime\(\s*\?\s*\)/gi, 'CAST(? AS TIMESTAMPTZ)')
        .replace(/date\(\s*'now'\s*\)/gi, 'CURRENT_DATE')
        .replace(/strftime\(\s*'%Y-%m-%d'\s*,\s*([^)]+)\)/gi, "to_char($1, 'YYYY-MM-DD')")
        .replace(/\bLIKE\s+\?\s+COLLATE\s+NOCASE\b/gi, 'ILIKE ?')
        .replace(/\bdf\.rowid\b/gi, 'df.id')
        .replace(/\browid\b/gi, 'id')
        .replace(/\bstatus\s*=\s*"published"/gi, "status = 'published'");
    }

    convertPlaceholders(sql) {
      let index = 0;
      let quote = null;
      let output = '';

      for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];
        const next = sql[i + 1];

        if (quote) {
          output += char;
          if (char === quote) {
            if (next === quote) {
              output += next;
              i += 1;
            } else {
              quote = null;
            }
          }
          continue;
        }

        if (char === "'" || char === '"') {
          quote = char;
          output += char;
          continue;
        }

        if (char === '?') {
          index += 1;
          output += `$${index}`;
        } else {
          output += char;
        }
      }

      return output;
    }

    async getConflictColumns(tableName, insertColumns) {
      const key = String(tableName).toLowerCase();
      if (!this.constraintCache.has(key)) {
        const result = await this.pool.query(
          `SELECT tc.constraint_type,
                  array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.constraint_schema = kcu.constraint_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = $1
              AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
            GROUP BY tc.constraint_name, tc.constraint_type
            ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END`,
          [key]
        );
        this.constraintCache.set(key, result.rows.map(row => row.columns));
      }

      const available = new Set(insertColumns.map(column => column.toLowerCase()));
      return (this.constraintCache.get(key) || []).find(columns => columns.every(column => available.has(column.toLowerCase()))) || [];
    }

    async prepareQuery(query, params = []) {
      let sql = String(query).trim();
      sql = this.normalizeCreateTable(sql);
      sql = this.normalizeSqliteDateFunctions(sql);
      sql = sql.replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?');

      const isIgnore = /^INSERT\s+OR\s+IGNORE\s+/i.test(sql);
      const isReplace = /^INSERT\s+OR\s+REPLACE\s+/i.test(sql);
      sql = sql.replace(/^INSERT\s+OR\s+(IGNORE|REPLACE)\s+/i, 'INSERT ');

      if (isIgnore) {
        sql = sql.replace(/;\s*$/, '');
        sql += ' ON CONFLICT DO NOTHING';
      }

      if (isReplace) {
        const match = sql.match(/^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/is);
        if (!match) {
          throw new Error(`Unable to translate SQLite INSERT OR REPLACE query: ${query}`);
        }
        const tableName = match[1];
        const columns = match[2].split(',').map(value => value.trim().replace(/^"|"$/g, ''));
        const conflictColumns = await this.getConflictColumns(tableName, columns);
        if (!conflictColumns.length) {
          throw new Error(`No compatible unique constraint found for SQLite INSERT OR REPLACE on ${tableName}`);
        }
        const conflictSet = new Set(conflictColumns.map(column => column.toLowerCase()));
        const updates = columns
          .filter(column => !conflictSet.has(column.toLowerCase()))
          .map(column => `${this.quoteIdentifier(column)} = EXCLUDED.${this.quoteIdentifier(column)}`);

        sql = sql.replace(/;\s*$/, '');
        sql += updates.length
          ? ` ON CONFLICT (${conflictColumns.map(column => this.quoteIdentifier(column)).join(', ')}) DO UPDATE SET ${updates.join(', ')}`
          : ` ON CONFLICT (${conflictColumns.map(column => this.quoteIdentifier(column)).join(', ')}) DO NOTHING`;
      }

      return { text: this.convertPlaceholders(sql), values: params };
    }

    async executeQuery(query, params = []) {
      const raw = String(query).trim();
      const inManagedTransaction = Boolean(this.transactionStorage.getStore());
      if (inManagedTransaction && /^(BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK)\s*;?$/i.test(raw)) {
        return { lastID: null, changes: 0, rowCount: 0 };
      }

      const prepared = await this.prepareQuery(query, params);
      try {
        const result = await this.queryClient().query(prepared.text, prepared.values);
        return {
          lastID: result.rows?.[0]?.id || null,
          changes: result.rowCount,
          rowCount: result.rowCount
        };
      } catch (error) {
        this.logger.error(`Postgres query failed: ${error.message}`);
        error.query = prepared.text;
        throw error;
      }
    }

    async getRow(query, params = []) {
      const prepared = await this.prepareQuery(query, params);
      const result = await this.queryClient().query(prepared.text, prepared.values);
      return result.rows[0] || null;
    }

    async getAllRows(query, params = []) {
      const prepared = await this.prepareQuery(query, params);
      const result = await this.queryClient().query(prepared.text, prepared.values);
      return result.rows;
    }

    async backup() {
      this.logger.info('Skipping local SQLite backup; Supabase manages Postgres persistence and backups');
      return 'supabase-managed';
    }

    async getDatabaseSize() {
      const result = await this.pool.query('SELECT pg_database_size(current_database()) AS bytes');
      const bytes = Number(result.rows[0]?.bytes || 0);
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    async close() {
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
        this.db = null;
      }
    }
  };
}

module.exports = { createPostgresDatabaseClass };
