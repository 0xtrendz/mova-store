import { describe, it, expect } from "vitest";
import {
  mergeOrderEvent,
  mergeOrderEvents,
  eventToOrder,
  OrderEvent,
} from "../../../lib/stellar/orders";

function createMockOrder(overrides: Partial<OrderEvent> = {}): OrderEvent {
  return {
    orderId: "order_1234567890abcdef",
    buyer: "GBUYER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD",
    amount: "45.00",
    amountRaw: BigInt(450000000),
    token: "CUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD",
    tokenSymbol: "USDC",
    status: "Paid",
    timestamp: 1700000000000,
    ledger: 1000,
    txHash: "txhash_pay_1234567890abcdef",
    ...overrides,
  };
}

describe("mergeOrderEvent", () => {
  it("merges a dispatch event over an existing Paid row: keeps buyer and tokenSymbol, and updates status to Shipped", () => {
    const existing = createMockOrder({
      status: "Paid",
      ledger: 1000,
      txHash: "tx_pay_1",
    });

    // Dispatch events derive buyer from topic2 (merchant) and lack amount/token details
    const dispatchIncoming: OrderEvent = {
      orderId: "order_1234567890abcdef",
      buyer: "GMERCHANT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890AB",
      amount: "0.00",
      amountRaw: BigInt(0),
      token: "",
      tokenSymbol: "TOKEN",
      status: "Shipped",
      timestamp: 1700000050000,
      ledger: 1005,
      txHash: "tx_dispatch_2",
    };

    const merged = mergeOrderEvent(existing, dispatchIncoming);

    // Lifecycle fields are carried forward from the newer dispatch event
    expect(merged.status).toBe("Shipped");
    expect(merged.ledger).toBe(1005);
    expect(merged.txHash).toBe("tx_dispatch_2");
    expect(merged.timestamp).toBe(1700000050000);

    // Payment and identity fields are strictly preserved from the original Paid row
    expect(merged.buyer).toBe("GBUYER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD");
    expect(merged.tokenSymbol).toBe("USDC");
    expect(merged.token).toBe("CUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD");
    expect(merged.amount).toBe("45.00");
    expect(merged.amountRaw).toBe(BigInt(450000000));
    expect(merged.orderId).toBe("order_1234567890abcdef");
  });

  it("merges a refund event over an existing Paid row: preserves buyer and token and updates status to Refunded", () => {
    const existing = createMockOrder({
      status: "Paid",
      ledger: 2000,
      txHash: "tx_pay_refund_test",
    });

    const refundIncoming: OrderEvent = {
      orderId: "order_1234567890abcdef",
      buyer: "GMERCHANT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890AB",
      amount: "0.00",
      amountRaw: BigInt(0),
      token: "",
      tokenSymbol: "TOKEN",
      status: "Refunded",
      timestamp: 1700000090000,
      ledger: 2010,
      txHash: "tx_refund_event",
    };

    const merged = mergeOrderEvent(existing, refundIncoming);

    expect(merged.status).toBe("Refunded");
    expect(merged.ledger).toBe(2010);
    expect(merged.txHash).toBe("tx_refund_event");
    expect(merged.timestamp).toBe(1700000090000);

    expect(merged.buyer).toBe(existing.buyer);
    expect(merged.tokenSymbol).toBe("USDC");
    expect(merged.amount).toBe("45.00");
    expect(merged.amountRaw).toBe(BigInt(450000000));
  });

  it("is a pure function that does not mutate either input and returns a new object", () => {
    const existing = createMockOrder();
    const incoming: OrderEvent = {
      orderId: existing.orderId,
      buyer: "GMERCHANT",
      amount: "0.00",
      amountRaw: BigInt(0),
      token: "",
      tokenSymbol: "TOKEN",
      status: "Shipped",
      timestamp: 1700000010000,
      ledger: 1001,
      txHash: "tx_new",
    };

    const merged = mergeOrderEvent(existing, incoming);

    expect(merged).not.toBe(existing);
    expect(merged).not.toBe(incoming);
    expect(existing.status).toBe("Paid");
    expect(existing.ledger).toBe(1000);
    expect(incoming.status).toBe("Shipped");
  });

  it("does not regress terminal status if an older or out-of-order Pending event arrives", () => {
    const existing = createMockOrder({
      status: "Shipped",
      ledger: 3000,
    });

    const pendingIncoming: OrderEvent = {
      orderId: existing.orderId,
      buyer: existing.buyer,
      amount: "45.00",
      amountRaw: BigInt(450000000),
      token: existing.token,
      tokenSymbol: existing.tokenSymbol,
      status: "Pending",
      timestamp: 1699999000000,
      ledger: 2950,
      txHash: "tx_pending_old",
    };

    const merged = mergeOrderEvent(existing, pendingIncoming);
    expect(merged.status).toBe("Shipped");
    expect(merged.ledger).toBe(3000);
  });

  it("exports mergeOrderEvents alias that functions identically", () => {
    expect(mergeOrderEvents).toBe(mergeOrderEvent);
  });
});

describe("eventToOrder topic mapping", () => {
  // Topic layouts declared in contracts/checkout/src/events.rs:
  //   create_order: (symbol_short!("create_order"), order_id, buyer, token, amount)
  //   pay:          (symbol_short!("pay"), order_id, buyer, token, amount)
  //   dispatch:     (symbol_short!("dispatch"), order_id, merchant)
  //   refund:       (symbol_short!("refund"), order_id, buyer, token, amount)
  const ORDER_ID = "order_1234567890abcdef";
  const BUYER = "GBUYER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD";
  const MERCHANT = "GMERCHANT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890AB";
  const TOKEN = "CUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCD";

  it("maps create_order using topic1 as order id (not topic0)", () => {
    const topics = ["create_order", ORDER_ID, BUYER, TOKEN, "45.00"];
    const order = eventToOrder(topics, 1700000000000, 1000, "tx_create");
    expect(order.orderId).toBe(ORDER_ID);
    expect(order.buyer).toBe(BUYER);
    expect(order.amount).toBe("45.00");
    expect(order.status).toBe("Pending");
  });

  it("maps pay using topic1 as order id and topic2 as buyer", () => {
    const topics = ["pay", ORDER_ID, BUYER, TOKEN, "45.00"];
    const order = eventToOrder(topics, 1700000010000, 1001, "tx_pay");
    expect(order.orderId).toBe(ORDER_ID);
    expect(order.buyer).toBe(BUYER);
    expect(order.amount).toBe("45.00");
    expect(order.status).toBe("Paid");
  });

  it("maps dispatch using topic1 as order id and topic2 as merchant", () => {
    const topics = ["dispatch", ORDER_ID, MERCHANT];
    const order = eventToOrder(topics, 1700000020000, 1002, "tx_dispatch");
    expect(order.orderId).toBe(ORDER_ID);
    expect(order.buyer).toBe(MERCHANT);
    expect(order.status).toBe("Shipped");
  });

  it("maps refund using topic1 as order id and topic2 as buyer", () => {
    const topics = ["refund", ORDER_ID, BUYER, TOKEN, "45.00"];
    const order = eventToOrder(topics, 1700000030000, 1003, "tx_refund");
    expect(order.orderId).toBe(ORDER_ID);
    expect(order.buyer).toBe(BUYER);
    expect(order.amount).toBe("45.00");
    expect(order.status).toBe("Refunded");
  });

  it("fails if topic0 (event name) is used as the order id", () => {
    const topics = ["pay", ORDER_ID, BUYER, TOKEN, "45.00"];
    const order = eventToOrder(topics, 1700000010000, 1001, "tx_pay");
    expect(order.orderId).not.toBe("pay");
    expect(order.orderId).toBe(ORDER_ID);
  });
});
