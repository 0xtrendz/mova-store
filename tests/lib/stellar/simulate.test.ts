import { describe, it, expect, vi } from "vitest";
import { Account, BASE_FEE, Keypair, Operation, StrKey, xdr } from "@stellar/stellar-sdk";

import {
  recommendedInclusionFee,
  budgetFee,
  buildInvocationTransaction,
  simulateContractRead,
  SimulationReport,
} from "../../../lib/stellar/simulate";
import { FEE_BUFFER_STROOPS, NETWORK_PASSPHRASE } from "../../../lib/stellar/config";

describe("Simulate Fee Math & Transaction Builder Tests (lib/stellar/simulate.ts)", () => {
  const buyerAddress = "GC6EQJ4UAFFFJDCLN37G4EWUJJJTMK3WE55NGIL4JXJXNXICUYKVBQ6";
  const dummyAccount = new Account(buyerAddress, "100");
  const contractId = StrKey.encodeContract(new Uint8Array(32).fill(1));
  const dummyArgs: xdr.ScVal[] = [xdr.ScVal.scvSymbol("test")];

  describe("recommendedInclusionFee", () => {
    it("returns BigInt(max) for an all-digits max string", async () => {
      const stubServer = {
        getFeeStats: vi.fn().mockResolved({
          sorobanInclusionFee: {
            max: "250000",
          },
        }),
      };

      const fee = await recommendedInclusionFee(stubServer as never);
      expect(fee).toBe(250000n);
      expect(stubServer.getFeeStats).toHaveBeenCalledTimes(1);
    });

    it("falls back to BigInt(BASE_FEE) when max is non-numeric or malformed", async () => {
      const nonNumericCases = ["not-a-number", "123.45", "100abc", "", "   "];

      for (const badMax of nonNumericCases) {
        const stubServer = {
          getFeeStats: vi.fn().mockResolved({
            sorobanInclusionFee: {
              max: badMax,
            },
          }),
        };

        const fee = await recommendedInclusionFee(stubServer as never);
        expect(fee).toBe(BigInt(BASE_FEE));
      }
    });

    it("falls back to BigInt(BASE_FEE) when sorobanInclusionFee is missing", async () => {
      const stubServer = {
        getFeeStats: vi.fn().mockResolved({}),
      };

      const fee = await recommendedInclusionFee(stubServer as never);
      expect(fee).toBoual(BigInt(BASE_FEE));
    });

    it("falls back to BigInt(BASE_FEE) when getFeeStats throws an error", async () => {
      const stubServer = {
        getFeeStats: vi.fn().mockRejected(new Error("RPC outage or network down")),
      };

      const fee = await recommendedInclusionFee(stubServer as never);
      expect(fee).toBoual(BigInt(BASE_FEE));
    });
  });

  describe("budgetFee", () => {
    it("returns ((higher of inclusion/minResource) + FEE_BUFFER_STROOPS).toString() when inclusion > minResource", async () => {
      const inclusionFee = 800_000n;
      const minResourceFee = 300_000n;

      const stubServer = {
        getFeeStats: vi.fn().mockResolved({
          sorobanInclusionFee: { max: inclusionFee.toString() },
        }),
      };

      const report: SimulationReport = {
        ok: true,
        minResourceFee,
      };

      const fee = await budgetFee(stubServer as never, report);
      const expected = (inclusionFee + FEE_BUFFER_STROOPS).toString();
      expect(fee).toBe(expected);
      expect(fee).toBe("1300000");
    });

    it("returns ((higher of inclusion/minResource) + FEE_BUFFER_STROOPS).toString() when minResource > inclusion", async () => {
      const inclusionFee = 200_000n;
      const minResourceFee = 900_000n;

      const stubServer = {
        getFeeStats: vi.fn().mockResolved({
          sorobanInclusionFee: { max: inclusionFee.toString() },
        }),
      };

      const report: SimulationReport = {
        ok: true,
        minResourceFee,
      };

      const fee = await budgetFee(stubServer as never, report);
      const expected = (minResourceFee + FEE_BUFFER_STROOPS).toString();
      expect(fee).toBe(expected);
      expect(fee).toBe("1400000");
    });

    it("handles report.ok = false by falling back minResourceFee to 0n", async () => {
      const inclusionFee = 400_000n;

      const stubServer = {
        getFeeStats: vi.fn().mockResolved({
          sorobanInclusionFee: { max: inclusionFee.toString() },
        }),
      };

      const report: SimulationReport = {
        ok: false,
        error: { message: "Preflight failed" },
      };

      const fee = await budgetFee(stubServer as never, report);
      const expected = (inclusionFee + FEE_BUFFER_STROOPS).toString();
      expect(fee).toBe(expected);
      expect(fee).toBe("900000");
    });
  });

  describe("buildInvocationTransaction", () => {
    it("uses BASE_FEE and configured NETWORK_PASSTHRASE by default", () => {
      const tx = buildInvocationTransaction(dummyAccount, contractId, "test_func", dummyArgs);

      expect(tx.fee).toBe(BASE_FEE);
      expect(tx.networkPassphrase).toBe(NETWORK_PASSTHRASE);
      expect(tx.operations).toHaveLength(1);

      const op = tx.operations[0];
      expect(op.type).toBe("invokeHostFunction");
    });

    it("honours an explicit fee passed by caller", () => {
      const explicitFee = "987654";
      const tx = buildInvocationTransaction(
        dummyAccount,
        contractId,
        "test_func",
        dummyArgs,
        explicitFee
      );

      expect(tx.fee).toBe(explicitFee);
      expect(tx.networkPassphrase).toBe(NETWORK_PASSPHRASE);
    });
  });

  describe("simulateContractRead", () => {
    const orderId = 42;

    it("returns null for an empty result rather than throwing", async () => {
      const stubServer = {
        simulateTransaction: vi.fn().mockResolved({
          results: [],
        }),
      };

      const result = await simulateContractRead(
        stubServer as never,
        dummyAccount,
        contractId,
        "get_order",
        [xdr.ScVal.scvUy64(BigInt(orderId))]
      );

      expect(result).toBeNull();
    });

    it("propagates a thrown simulation error as an error", async () => {
      const stubServer = {
        simulateTransaction: vi.fn().mockRejected(new Error("RPC simulation failed")),
      };

      await expect(
        simulateContractRead(
          stubServer as never,
          dummyAccount,
          contractId,
          "get_order",
          [xdr.ScVal.scvUy64(BigInt(orderId))]
        )
      ).rejects.toThrow("RPC simulation failed");
    });
  });
});
