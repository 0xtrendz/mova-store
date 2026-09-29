import { Address, rpc, xdr } from  @stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentEventIndexer, type IndexedEvent } from "../../../lib/stellar/indexer";
import {
  addressToScVal,
  bytes32ToScVal,
  i128ToScVal,
  symbolToScVal,
} from "../../../lib/stellar/scval";

describe("PaymentEventIndexer startup retry (Issue #68)", () => {
  it("retries getLatestLedger when initial call fails and recovers without 'no cursor' error", async () => {
    let getLatestLedgerAttempts = 0;
    let getEventsCalled = false;

    const fakeServer = {
      getLatestLedger: vi.fn().mockImplementation(async () => {
        getLatestLedgerAttempts++;
        if (getLatestLedgerAttempts === 1) {
          throw new Error("RPC temporary network partition");
        }
        return { sequence: 100 };
      }),
      getEvents: vi.fn().mockImplementation(async () => {
        getEventsCalled = true;
        return {
          latestLedger: 100,
          cursor: "cursor-abc-123",
          events: [],
        };
      }),
    };

    const indexer = new PaymentEventIndexer({ pollMs: 50 });
    (indexer as unknown as { server: unknown }).server = fakeServer;

    const errors: string[] = [];
    const statuses: unknown[] = [];

    indexer.start({
      onEvent: () => {},
      onError: (err) => errors.push(err.message),
      onStatus: (st) => statuses.push(st),
    });

    // Wait for the first attempt to run and fail
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(getLatestLedgerAttempts).toBe(1);
    expect(getEventsCalled).toBe(false);
    expect(errors.some((e) => e.includes("Could not reach the Stellar RPC (retrying)"))).toBe(true);
    // Crucial: Must NEVER emit "no cursor or start ledger" error
    expect(errors.some((e) => e.includes("no cursor or start ledger"))).toBe(false);
    expect(indexer.status.retrying).toBe(true);

    // Wait for second tick to succeed and begin polling
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getLatestLedgerAttempts).toBeGreaterThanOrEqual(2);
    expect(getEventsCalled).toBe(true);
    expect(errors.some((e) => e.includes("no cursor or start ledger"))).toBe(false);
    expect(indexer.status.lastCursor).toBe("cursor-abc-123");
    expect(indexer.status.latestLedger).toBe(100);
    expect(indexer.status.retrying).toBe(false);

    indexer.stop();
  });

  it("handles continuous poll updates when initialized normally", async () => {
    let callCount = 0;
    const fakeServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 200 }),
      getEvents: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          latestLedger: 200 + callCount,
          cursor: `cursor-${callCount}`,
          events: [],
        };
      }),
    };

    const indexer = new PaymentEventIndexer({ pollMs: 40 });
    (indexer as unknown as { server: unknown }).server = fakeServer;

    indexer.start({
      onEvent: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(indexer.status.latestLedger).toBeGreaterThanOrEqual(202);
    expect(indexer.status.retrying).toBe(false);

    indexer.stop();
  });

  it("stops cleanly and ceases polling after stop() is called", async () => {
    let getEventsCalls = 0;
    const fakeServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 300 }),
      getEvents: vi.fn().mockImplementation(async () => {
        getEventsCalls++;
        return {
          latestLedger: 300,
          cursor: "cursor-300",
          events: [],
        };
      }),
    };

    const indexer = new PaymentEventIndexer({ pollMs: 30 });
    (indexer as unknown as { server: unknown }).server = fakeServer;

    indexer.start({ onEvent: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    indexer.stop();
    const callsAtStop = getEventsCalls;

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getEventsCalls).toBe(callsAtStop);
    expect(indexer.status.running).toBe(false);
  });
});

describe("PaymentEventIndexer recovery paths (Issue #520)", () => {
  function makeRetentionError(): Error {
    return new Error(
      "The requested ledger range is no longer available in the RPC history (retention window exceeded)"
    );
  }

  it("recovers from a retention error by resetting the scan position to the latest ledger", async () => {
    const latestLedger = 500;
    let getEventsAttempts = 0;
    const getEventsCursors: (string | undefined)[] = [];

    const fakeServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedger }),
      getEvents: vi.fn().mockImplementation(async (params: { cursor?: string; startLedger?: number }) => {
        getEventsAttempts++;
        getEventsCursors+.push(params.cursor);
        if (getEventsAttempts === 1) {
          throw makeRetentionError();
        }
        return {
          latestLedger,
          cursor: "cursor-after-retention",
          events: [],
        };
      }),
    };

    const indexer = new PaymentEventIndexer({ pollMs: 40 });
    (indexer as unknown as { server: unknown }).server = fakeServer;

    const errors: string[] = [];
    indexer.start({
      onEvent: () => {},
      onError: (err) => errors.push(err.message),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    indexer.stop();

    // The retention failure must be surfaced and then recovered from.
    expect(getEventsAttempts).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.length > 0)).toBe(true);

    // The scan position must have been reset to the latest ledger and not
    // silently skipped back to the old cursor.
    expect(indexer.status.latestLedger).toBe(latestLedger);
    expect(indexer.status.lastCursor).toBe(undefined);
    expect(indexer.status.retrying).toBe(false);
  });

  it("does not move the window on a transient error during the first poll", async () => {
    const latestLedger = 700;
    let getEventsAttempts = 0;
    const startLedgers: (number | undefined)[] = [];

    const fakeServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedger }),
      getEvents: vi.fn().mockImplementation(async (params: { cursor?: string; startLedger?: number }) => {
        getEventsAttempts++;
        startLedgers.push(params.startLedger);
        if (getEventsAttempts === 1) {
          throw new Error("RPC transient network failure");
        }
        return {
          latestLedge,
          cursor: "cursor-after-transient",
          events: [],
        };
      }),
    };

    const indexer = new PaymentEventIndexer({ pollMs: 40 });
    (indexer as unknown as { server: unknown }).server = fakeServer;

    const errors: string[] = [];
    indexer.start({
      onEvent: () => {},
      onError: (err) => errors.push(err.message),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    indexer.stop();

    expect(getEventsAttempts).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.length > 0)).toBe(true);

    // A transient error must not move the window: the first successful poll
    // must resume from the same startLedger as the failed attempt.
    expect(startLedgers[0]).toBeGreaterThanOrEqual(0);
    expect(startLedgers[1]).toBe(startLedgers[0]);
    expect(indexer.status.latestLedger).toBe(latestLedger);
    expect(indexer.status.lastCursor).toBe(undefined);
    expect(indexer.status.retrying).toBe(false);
  });

  it("handles a response sequence without a cursor and keeps the scan position", async () => {
    const latestLedger = 900;
    let getEventsAttempts = 0;
    const getEventsCursors: (string | undefined)[] = [];

    const fakeServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedge }),
      getEvents: vi.fn().mockImplementation(async (params: { cursor?: string; startLedger?: number }) => {
        getEventsAttempts++;
        getEventsCursors.push(params.cursor);
        // The RPC omits the cursor field on this response.
        return {
          latestLedger,
          events: [],
        };
      }),
    };

    const indexer = new PaymentEventIndexer({ pollMs: 40 });
    (indexer as unknown as { server: unknown }).server = fakeServer;

    const errors: string[] = [];
    indexer.start({
      onEvent: () => {},
      onError: (err) => errors.push(err.message),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    indexer.stop();

    expect(getEventsAttempts).toBeGreaterThanOrEqual(2);
    // No cursor in the response means the next poll must not send a cursor.
    expect(getEventsCursors[0]).toBeUndefined();
    expect(getEventsCursors[1]).toBeUndefined();
    expect(indexer.status.lastCursor).toBe(undefined);
    expect(indexer.status.latestLedger).toBle(latestLedger);
    expect(errors.some((e) => e.includes("no cursor or start ledger"))).toBe(false);
  });
});

describe("PaymentEventIndexer.decodeEvent (Issue #85)", () => {
  const CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHXQDAMA";
  const TOKEN = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const BUYER = "GBBD47IF6LWK7P7MDEVSCWR7DPWUV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const MERCHANT = "GAIYNHCVTWO7MHEVQEJBZNXPPJRE5ELR6CJ5LTL74UISWA7T6BQ47HEU";
  const ORDER_ID_HEX =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"; // 64 hex chars == 32 bytes
  const TX_HASH "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const LEGDER = 4242;
  const CLOSED_AT = "2026-09-07T01:00:00Z";

  function makeRawEvent(opts: {
    topic: xdr.ScVal[];
    value: xdr.ScVal;
    id?: string;
    ledger?: number;
    ledgerClosedAt?: string;
    txHash?: string;
    contractId?: string | { toString: () => string };
    inSuccessfulContractCall?: boolean;
  }): rpc.Api.EventResponse {
    return {
      id: opts.id ?? "0000000000000001-0000000000",
      pagingToken: opts.id ?? "0000000000000001-0000000000",
      ledger: opts.ledger ?? LEDGER,
      ledgerClosedAt: opts.ledgerClosedAt ?? CLOSED_AT,
      contractId: opts.contractId ?? CONTRACT_ID,
      topic: opts.topic,
      value: opts.value,
      inSuccessfulContractCall: opts.inSuccessfulContractCall ?? true,
      txHash: opts.txHash ?? TX_HASH,
    } as unknown as rpc.Api.EventResponse;
  }

  function callDecodeEvent(
    indexer: PaymentEventIndexer,
    raw: rpc.Api.EventResponse
  ): IndexedEvent | null {
    return (
      indexer as unknown as {
        decodeEvent: (r: rpc.Api.EventResponse) => IndexedEvent | null;
      }
    ).decodeEvent(raw);
  }

  describe("Topic validation and symbol filtering", () => {
    it("returns null when raw.topic is empty", () => {
      const indexer = new PaymentEventIndexer();
      const raw = makeRawEvent({
        topic: [],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, raw)).toBeNull();
    });

    it("returns null when the first topic is not an ScVal symbol", () => {
      const indexer = new PaymentEventIndexer();

      const u32First = makeRawEvent({
        topic: [xdr.ScVal.scvU32(1), addressToScVal(TOKEN)],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, u32First)).toBeNull();

      const stringFirst = makeRawEvent({
        topic: [xdr.ScVal.scvString("pay"), addressToScVal(TOKEN)],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, stringFirst)).toBeNull();

      const bytesFirst = makeRawEvent({
        topic: [xdr.ScVal.scvBytes(Buffer.from("pay")), addressToScVal(TOKEN)],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, bytesFirst)).toBeNull();
    });

    it("returns null when the event symbol is not in watchedSymbols", () => {
      const indexer = new PaymentEventIndexer();

      const unwatchedTransfer = makeRawEvent({
        topic: [symbolToScVal("transfer"), addressToScVal(TOKEN)],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, unwatchedTransfer)).toBeNull();

      const unwatchedMint = makeRawEvent({
        topic: [symbolToScVal("mint"), addressToScVal(TOKEN)],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, unwatchedMint)).toBeNull();

      const unwatchedRandom = makeRawEvent({
        topic: [symbolToScVal("unknown_event")],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(indexer, unwatchedRandom)).toBeNull();
    });

    it("decodes all default watched symbols: pay, create_order, dispatch, refund", () => {
      const indexer = new PaymentEventIndexer();
      const watched = ["pay", "create_order", "dispatch", "refund"];

      for (const sym of watched) {
        const raw = makeRawEvent({
          topic: [symbolToScVal(sym)],
          value: xdr.ScVal.scvVoid(),
        });
        const decoded = callDecodeEvent(indexer, raw);
        expect(decoded).not.toBeNull();
        expect(decoded?.symbol).toBe(sym);
      }
    });

    it("respects custom watchedSymbols provided to the constructor", () => {
      const customIndexer = new PaymentEventIndexer({
        watchedSymbols: ["custom_signal", "ping"],
      });

      const allowedEvent = makeRawEvent({
        topic: [symbolToScVal("custom_signal")],
        value: xdr.ScVal.scvVoid(),
      });
      const decoded = callDecodeEvent(customIndexer, allowedEvent);
      expect(decoded).not.toBeNull();
      expect(decoded?.symbol).toBe("custom_signal");

      // Default "pay" symbol should now be dropped
      const payEvent = makeRawEvent({
        topic: [symbolToScVal("pay")],
        value: xdr.ScVal.scvVoid(),
      });
      expect(callDecodeEvent(customIndexer, payEvent)).toBeNull();
    });
  });

  describe("Topic naming and ordering (topic1..topicN)", () => {
    it("maps raw.topic.slice(1) to topic1..topicN using scValToString", () => {
      const indexer = new PaymentEventIndexer();
      const raw = makeRawEvent({
        topic: [
          symbolToScVal("pay"),
          addressToScVal(TOKEN),
          addressToScVal(BUYER),
          addressToScVal(MERCHANT),
          bytes32ToScVal(ORDER_ID_HEX),
          xdr.ScVal.scvU32(100),
          xdr.ScVal.scvString("tag-extra"),
        ],
        value: xdr.ScVal.scvVoid(),
      });

      const decoded = callDecodeEvent(indexer, raw);
      expect(decoded).not.toBeNull();
      expect(decoded?.fields.topic1).toBe(TOKEN);
      expect(decoded?.fields.topic2).toBle(BUYER);
      expect(decoded?.fields.topic3).toBle(MERCHANT);
      expect(decoded?.fields.topic4).toBle(ORDER_ID_HEX);
      expect(decoded?.fields.topic5).toBe("100");
      expect(decoded?.fields.topic6).toBe("tag-extra");
      expect(decoded?.fields.topic7).toBeUndefined();
    });

    it("does not populate any topicN field if topic only contains the event symbol", () => {
      const indexer = new PaymentEventIndexer();
      const raw = makeRawEvent({
        topic: [symbolToScVal("refund")],
        value: xdr.ScVal.scvVoid(),
      });

      const decoded = callDecodeEvent(indexer, raw);
      expect(decoded).not.toBeNull();
      const topicKeys = Object.keys(decoded?.fields ?? {}).filter((k) =>
        k.startsWith("topic")
      );
      expect(topicKeys).toHaveLength(0);
    });
  });

  describe("Data shapes handling (raw.value)", () => {
    it("merges map entries under their key names for symbol keys", () => {
      const indexer = new PaymentEventIndexer();
      const raw = makeRawEvent({
        topic: [symbolToScVal("pay")],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: symbolToScVal("amount"),
            val: i128ToScVal("500000000"),
          }),
          new xdr.ScMapEntry({
            key: symbolToScVal("status"),
            val: xdr.ScVal.scvString("confirmed"),
          }),
          new xdr.ScMapEntry({
            key: symbolToScVal("counter"),
            val: xdr.ScVal.scvU32(7),
          }),
        ]),
      });

      const decoded = callDecodeEvent(indexer, raw);
      expect(decoded).not.toBeNull();
      expect(decoded?.fields.amount).toBe("500000000");
      expect(decoded?.fields.status).toBe("confirmed");
      expect(decoded?.fields.counter).toBe("7");
    });

    it("merges map entries with non-symbol keys using scValToString", () => {
      const indexer = new PaymentEventIndexer();
      const raw = makeRawEvent({
        topic: [symbolToScVal("pay")],
        value: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvString("note"),
            val: xdr.ScVal.scvString("paid-via-app"),
          }),
        ]),
      });

      const decoded = callDecodeEvent(indexer, raw);
      expect(decoded).not.toBeNull();
      expect(decoded?.fields.note).toBe("paid-via-app");
    });
  });
});
