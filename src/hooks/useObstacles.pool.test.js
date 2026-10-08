// Pool Nostr : reconnexion au retour au premier plan (régression de 7079b97).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NostrPool } from "./useObstacles.js";

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeWS.all.push(this); }
  send() {}
  close() { this.onclose?.(); }
}

describe("NostrPool — arrière-plan puis premier plan", () => {
  let listeners;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.all = [];
    listeners = {};
    globalThis.WebSocket = FakeWS;
    globalThis.document = {
      hidden: false,
      addEventListener: (t, f) => { listeners[t] = f; },
      removeEventListener: (t) => { delete listeners[t]; },
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
    delete globalThis.WebSocket;
  });

  it("rouvre au retour au premier plan un relais fermé pendant l'arrière-plan", () => {
    const pool = new NostrPool(["wss://relais.test"]);
    pool.connect();
    expect(FakeWS.all).toHaveLength(1);
    document.hidden = true;
    FakeWS.all[0].close();                      // l'OS tue le socket écran éteint
    vi.advanceTimersByTime(20_000);
    expect(FakeWS.all).toHaveLength(1);         // pas de reconnexion en arrière-plan (voulu)
    document.hidden = false;
    listeners.visibilitychange();               // retour au premier plan
    expect(FakeWS.all).toHaveLength(2);         // avant : jamais rouvert
    pool.close();
    expect(listeners.visibilitychange).toBeUndefined();
  });

  it("une reconnexion programmée avant la mise en arrière-plan est annulée", () => {
    const pool = new NostrPool(["wss://relais.test"]);
    pool.connect();
    FakeWS.all[0].close();                      // fermé au premier plan → minuterie 5-10 s
    document.hidden = true;
    vi.advanceTimersByTime(20_000);
    expect(FakeWS.all).toHaveLength(1);
    pool.close();
  });
});
