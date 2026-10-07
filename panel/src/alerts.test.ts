// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertNewWork, alertsOn, setAlerts } from "./alerts";

describe("uyarılar", () => {
  let notified: { title: string; body?: string }[];
  let beeps: number;
  beforeEach(() => {
    localStorage.clear();
    notified = [];
    beeps = 0;
    class FakeAudio {
      currentTime = 0;
      destination = {};
      resume() { return Promise.resolve(); }
      createOscillator() { beeps++; return { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n }; }
    }
    vi.stubGlobal("AudioContext", FakeAudio);
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: { body?: string }) { notified.push({ title, body: opts?.body }); }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("varsayılan açık; tercih saklanır", () => {
    expect(alertsOn()).toBe(true);
    setAlerts(false);
    expect(alertsOn()).toBe(false);
    setAlerts(true);
    expect(alertsOn()).toBe(true);
  });

  it("açıkken ses çalar; sayfa görünür ve odaktaysa masaüstü bildirimi çıkmaz", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    alertNewWork(2, 5);
    expect(beeps).toBe(2); // iki nota
    expect(notified).toEqual([]);
  });

  it("pencere arka plandaysa masaüstü bildirimi çıkar ve müşteri bilgisi taşımaz", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    alertNewWork(2, 5);
    expect(notified).toEqual([{ title: "Lina: yeni iş geldi", body: "2 yeni iş. Toplam 5 iş bekliyor." }]);
  });

  it("kapalıyken ne ses ne bildirim; izin yoksa yalnızca ses", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    setAlerts(false);
    alertNewWork(1, 1);
    expect(beeps).toBe(0);
    expect(notified).toEqual([]);
    setAlerts(true);
    (Notification as unknown as { permission: string }).permission = "denied";
    alertNewWork(1, 1);
    expect(beeps).toBe(2);
    expect(notified).toEqual([]);
  });
});
