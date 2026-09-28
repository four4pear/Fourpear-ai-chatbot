import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/core/conversation.js";
import { openDatabase, type Database } from "../src/db/client.js";

let database: Database;
let server: Server;
let base: string;
let dist: string;

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), "lina-panel-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log(1)");

  database = await openDatabase({});
  const log = { info() {}, warn() {}, error() {} };
  const { app } = createApp({ WHATSAPP_APP_SECRET: "x", WHATSAPP_VERIFY_TOKEN: "verify" }, { db: database.db, log } as unknown as Deps, undefined, {
    db: database.db,
    publicUrl: "http://panel.test",
    allowedOrigins: ["http://panel.test"],
    secureCookies: false,
    log,
    distDir: dist,
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await database.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("panel dosyaları", () => {
  it("panel adresleri aynı sayfayı güvenlik başlıklarıyla açar", async () => {
    for (const p of ["/", "/giris", "/yonetici", "/davet/abc", "/sifre/abc", "/m/maius/bekleyenler", "/m/maius/ayarlar"]) {
      const res = await fetch(base + p);
      expect(res.status, p).toBe(200);
      expect(await res.text()).toContain('<div id=root>');
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("derlenmiş dosyaları uzun süreli önbellekle verir", async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("API ve WhatsApp adresleri panelden etkilenmez", async () => {
    const me = await fetch(`${base}/api/me`);
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ error: "Oturum açın" });

    const verify = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42`);
    expect(await verify.text()).toBe("42");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("bilinmeyen adresler panel sayfası açmaz", async () => {
    expect((await fetch(`${base}/baska-bir-sey`)).status).toBe(404);
    expect((await fetch(`${base}/assets/yok.js`)).status).toBe(404);
  });
});
