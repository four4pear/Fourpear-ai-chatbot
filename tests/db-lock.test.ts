import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseLockedError, openDatabase } from "../src/db/client.js";

describe("yerel veritabanı kilidi", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lina-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lockFile = () => path.join(dir, ".lina.lock");

  it("açıkken ikinci açma girişimini açıklayıcı hatayla reddeder, kapanınca bırakır", async () => {
    const first = await openDatabase({ pgliteDir: dir });
    expect(readFileSync(lockFile(), "utf8")).toBe(String(process.pid));

    const second = openDatabase({ pgliteDir: dir });
    await expect(second).rejects.toBeInstanceOf(DatabaseLockedError);
    await expect(second).rejects.toThrow("Önce çalışan sunucuyu durdurun");

    await first.close();
    expect(existsSync(lockFile())).toBe(false);

    const again = await openDatabase({ pgliteDir: dir });
    await again.close();
  });

  it("çökmüş bir programdan kalan eski kilidi devralır", async () => {
    // Çalışmayan bir işlem numarası (işletim sistemlerinde bu kadar büyük pid kullanılmaz).
    writeFileSync(lockFile(), "99999999");
    const db = await openDatabase({ pgliteDir: dir });
    expect(readFileSync(lockFile(), "utf8")).toBe(String(process.pid));
    await db.close();
  });

  it("bellekteki veritabanı kilit kullanmaz", async () => {
    const a = await openDatabase({});
    const b = await openDatabase({});
    await Promise.all([a.close(), b.close()]);
  });
});
