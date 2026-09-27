import path from "node:path";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";

// İki sürücünün sorgu API'si aynı; uygulama tek tip üzerinden çalışır.
export type DB = NodePgDatabase<typeof schema>;

const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");

export type Database = { db: DB; close: () => Promise<void> };

/**
 * DATABASE_URL varsa gerçek Postgres'e (Railway vb.) bağlanır.
 * Yoksa yerel geliştirme için gömülü PGlite kullanır (dataDir verilmezse bellekte).
 */
export async function openDatabase(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    return { db, close: () => pool.end() };
  }

  // Bellekte açılan veritabanı başka programla paylaşılmaz; kilit gerekmez.
  let releaseLock = () => {};
  if (opts.pgliteDir) {
    mkdirSync(opts.pgliteDir, { recursive: true });
    releaseLock = acquireLock(opts.pgliteDir);
  }
  try {
    const client = new PGlite(opts.pgliteDir);
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder });
    return {
      db: db as unknown as DB,
      close: async () => {
        await client.close();
        releaseLock();
      },
    };
  } catch (err) {
    releaseLock();
    throw err;
  }
}

export class DatabaseLockedError extends Error {}

/** Komut satırı programları için: kilit hatasında yığın dökümü yerine açıklamayı yazıp çıkar. */
export function exitIfLocked(err: unknown): never {
  if (err instanceof DatabaseLockedError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

/**
 * PGlite aynı klasörün iki programdan açılmasını engellemez ve eşzamanlı yazma veritabanını
 * bozabilir. Bu yüzden klasöre işlem numarasını içeren bir kilit dosyası koyarız.
 * Kilidi bırakmadan çöken bir programın kilidi, o işlem artık çalışmıyorsa devralınır.
 */
function acquireLock(dir: string): () => void {
  const file = path.join(dir, ".lina.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        try {
          if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
        } catch {
          // Dosya zaten yoksa sorun değil.
        }
      };
      process.on("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number(readFileSync(file, "utf8"));
      if (owner && isRunning(owner)) {
        throw new DatabaseLockedError(
          `Yerel veritabanı (${dir}) şu an başka bir program tarafından kullanılıyor (işlem ${owner}). ` +
            "Aynı anda iki program açarsa veri bozulabilir. Önce çalışan sunucuyu durdurun (Ctrl+C), sonra tekrar deneyin.",
        );
      }
      unlinkSync(file); // sahibi artık çalışmayan eski kilit
    }
  }
  throw new DatabaseLockedError(`Yerel veritabanı kilidi alınamadı (${file}).`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // sinyal göndermez, sadece işlemin var olup olmadığına bakar
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
