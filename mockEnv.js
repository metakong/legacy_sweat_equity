/**
 * Local stand-ins for the Cloudflare bindings the Worker expects.
 *
 * D1 is backed by node:sqlite (built into Node 22.5+, so this stays a
 * zero-dependency dev setup). The previous implementation pattern-matched SQL
 * strings against a JSON file, which meant local dev could not catch a broken
 * JOIN, a bad ON CONFLICT clause, or an FK violation — every one of those only
 * showed up after deploy. This runs the Worker's real SQL against real SQLite,
 * the same engine D1 is built on.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = path.join(process.cwd(), '.local_db.sqlite');
const SCHEMA_FILE = path.join(process.cwd(), 'schema.sql');

/**
 * D1 only binds primitives. Coerce the shapes JS hands us into what SQLite
 * accepts so a stray boolean surfaces here rather than as an opaque 500.
 */
function bindable(value) {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  throw new TypeError(`D1 cannot bind a ${typeof value} (${JSON.stringify(value)?.slice(0, 60)})`);
}

/**
 * A D1Database-shaped wrapper. Supports the subset the Worker uses:
 * prepare().bind().all() / .first() / .run(), plus batch().
 */
export function createD1(file = DB_FILE) {
  const fresh = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  if (fresh) {
    if (!fs.existsSync(SCHEMA_FILE)) {
      throw new Error(`schema.sql not found at ${SCHEMA_FILE}`);
    }
    db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    console.log(`- Created local SQLite database at ${path.basename(file)} from schema.sql`);
  }

  const wrap = (sql) => {
    const run = (args) => {
      const params = args.map(bindable);
      // Prepared statements are created per call rather than cached: schema.sql
      // can be re-applied while the dev server is running, which invalidates
      // any statement held across that boundary.
      const stmt = db.prepare(sql);
      return {
        async all() {
          return { results: stmt.all(...params), success: true };
        },
        async first() {
          return stmt.get(...params) ?? null;
        },
        async run() {
          const info = stmt.run(...params);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        },
        async raw() {
          return stmt.all(...params).map((row) => Object.values(row));
        }
      };
    };

    return {
      bind: (...args) => run(args),
      all: () => run([]).all(),
      first: () => run([]).first(),
      run: () => run([]).run(),
      raw: () => run([]).raw()
    };
  };

  return {
    prepare: wrap,
    async batch(statements) {
      // D1's batch is a single implicit transaction.
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    _raw: db
  };
}

// ---------------------------------------------------------------------
// R2 — filesystem backed
// ---------------------------------------------------------------------
const R2_DIR = path.join(process.cwd(), '.local_r2');
if (!fs.existsSync(R2_DIR)) {
  fs.mkdirSync(R2_DIR, { recursive: true });
}

// Defense in depth: the Worker validates keys, but this mock writes to a real
// filesystem, so refuse anything that isn't a flat filename here too.
const SAFE_KEY_RE = /^[A-Za-z0-9._-]{1,120}$/;
const keyPath = (key) => {
  if (!SAFE_KEY_RE.test(key)) throw new Error(`Unsafe R2 key rejected: ${key}`);
  return path.join(R2_DIR, key);
};

export const mockR2 = {
  async put(key, buffer, options = {}) {
    const file = keyPath(key);
    fs.writeFileSync(file, Buffer.from(buffer));
    // Persist httpMetadata so get() round-trips the real Content-Type instead
    // of assuming every object is one format.
    fs.writeFileSync(
      `${file}.meta.json`,
      JSON.stringify({ contentType: options?.httpMetadata?.contentType || 'application/octet-stream' }),
      'utf8'
    );
  },
  async get(key) {
    let file;
    try {
      file = keyPath(key);
    } catch {
      return null;
    }
    if (!fs.existsSync(file)) return null;

    const body = fs.readFileSync(file);
    let contentType = 'application/octet-stream';
    try {
      contentType = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8')).contentType || contentType;
    } catch { /* objects written before metadata was tracked */ }

    return {
      body,
      httpMetadata: { contentType },
      writeHttpMetadata(headers) {
        headers.set('Content-Type', contentType);
      },
      httpEtag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`
    };
  },
  async delete(key) {
    try {
      const file = keyPath(key);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (fs.existsSync(`${file}.meta.json`)) fs.unlinkSync(`${file}.meta.json`);
    } catch { /* nothing to remove */ }
  }
};
