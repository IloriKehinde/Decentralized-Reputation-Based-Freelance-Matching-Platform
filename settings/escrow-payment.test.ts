// tests/escrow-payment.test.ts

import { describe, it, expect, beforeEach } from "vitest";

type EscrowState = {
  amount: bigint;
  payer: string;
  payee: string;
  token: string;
  deadline: bigint;
  released: boolean;
  refunded: boolean;
  "dispute-active": boolean;
  "votes-release": bigint;
  "votes-refund": bigint;
  "dispute-end-block": bigint;
  "created-at": bigint;
};

class EscrowMock {
  escrowNonce = 0n;
  escrows = new Map<bigint, EscrowState>();
  voters = new Map<string, boolean>();
  blockHeight = 100n;
  balances = new Map<string, bigint>();
  transfers: { from: string; to: string; amount: bigint }[] = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.escrowNonce = 0n;
    this.escrows.clear();
    this.voters.clear();
    this.blockHeight = 100n;
    this.balances.clear();
    this.transfers = [];
    this.balances.set("wallet1", 1000000n);
    this.balances.set("wallet2", 0n);
    this.balances.set("contract", 0n);
  }

  private transfer(amount: bigint, from: string, to: string) {
    const fromBal = this.balances.get(from) ?? 0n;
    if (fromBal < amount) throw new Error("ERR-TRANSFER-FAILED");
    this.balances.set(from, fromBal - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    this.transfers.push({ from, to, amount });
  }

  createEscrow(amount: bigint, payee: string, deadline: bigint) {
    if (amount < 1000n) throw new Error("ERR-INVALID-AMOUNT");
    if (deadline <= this.blockHeight) throw new Error("ERR-DEADLINE-IN-FUTURE");
    if (payee === "wallet1") throw new Error("ERR-NOT-AUTHORIZED");

    this.transfer(amount, "wallet1", "contract");

    const id = this.escrowNonce++;
    this.escrows.set(id, {
      amount,
      payer: "wallet1",
      payee,
      token: "mock-token",
      deadline,
      released: false,
      refunded: false,
      "dispute-active": false,
      "votes-release": 0n,
      "votes-refund": 0n,
      "dispute-end-block": 0n,
      "created-at": this.blockHeight,
    });
    return id;
  }

  release(id: bigint, caller: string) {
    const e = this.escrows.get(id);
    if (!e) throw new Error("ERR-ESCROW-NOT-FOUND");
    if (caller !== e.payer && caller !== e.payee) throw new Error("ERR-NOT-AUTHORIZED");
    if (e.released || e.refunded) throw new Error("ERR-ALREADY-RELEASED");
    if (e["dispute-active"]) throw new Error("ERR-DISPUTE-ACTIVE");
    if (this.blockHeight > e.deadline) throw new Error("ERR-DEADLINE-PASSED");

    this.transfer(e.amount, "contract", e.payee);
    e.released = true;
  }

  refund(id: bigint, caller: string) {
    const e = this.escrows.get(id);
    if (!e) throw new Error("ERR-ESCROW-NOT-FOUND");
    if (caller !== e.payer) throw new Error("ERR-NOT-AUTHORIZED");
    if (e.released || e.refunded) throw new Error("ERR-ALREADY-RELEASED");
    if (e["dispute-active"]) throw new Error("ERR-DISPUTE-ACTIVE");
    if (this.blockHeight <= e.deadline) throw new Error("ERR-DEADLINE-PASSED");

    this.transfer(e.amount, "contract", e.payer);
    e.refunded = true;
  }

  raiseDispute(id: bigint, caller: string) {
    const e = this.escrows.get(id);
    if (!e) throw new Error("ERR-ESCROW-NOT-FOUND");
    if (caller !== e.payer && caller !== e.payee) throw new Error("ERR-NOT-AUTHORIZED");
    if (e.released || e.refunded || e["dispute-active"]) throw new Error("ERR-DISPUTE-ACTIVE");

    e["dispute-active"] = true;
    e["dispute-end-block"] = this.blockHeight + 2016n;
  }

  vote(id: bigint, voter: string, supportRelease: boolean) {
    const e = this.escrows.get(id);
    if (!e) throw new Error("ERR-ESCROW-NOT-FOUND");
    if (!e["dispute-active"]) throw new Error("ERR-DISPUTE-INACTIVE");
    if (this.blockHeight >= e["dispute-end-block"]) throw new Error("ERR-DEADLINE-PASSED");

    const key = `${id}-${voter}`;
    if (this.voters.has(key)) throw new Error("ERR-ALREADY-VOTED");
    this.voters.set(key, true);

    if (supportRelease) e["votes-release"] += 1n;
    else e["votes-refund"] += 1n;

    const total = e["votes-release"] + e["votes-refund"];
    if (total === 0n) return;

    const releasePct = (e["votes-release"] * 100n) / total;
    const refundPct = (e["votes-refund"] * 100n) / total;

    if (releasePct >= 66n) {
      this.transfer(e.amount, "contract", e.payee);
      e.released = true;
      e["dispute-active"] = false;
    } else if (refundPct >= 66n) {
      this.transfer(e.amount, "contract", e.payer);
      e.refunded = true;
      e["dispute-active"] = false;
    } else if (this.blockHeight >= e["dispute-end-block"]) {
      this.transfer(e.amount, "contract", e.payer);
      e.refunded = true;
      e["dispute-active"] = false;
    }
  }
}

describe("escrow-payment.clar - Pure Mock Security Tests", () => {
  let mock: EscrowMock;

  beforeEach(() => {
    mock = new EscrowMock();
  });

  it("creates escrow with valid parameters", () => {
    const id = mock.createEscrow(50000n, "wallet2", 200n);
    expect(id).toBe(0n);
    expect(mock.balances.get("contract")).toBe(50000n);
  });

  it("rejects amount below minimum", () => {
    expect(() => mock.createEscrow(500n, "wallet2", 200n)).toThrow("ERR-INVALID-AMOUNT");
  });

  it("releases funds before deadline", () => {
    mock.createEscrow(30000n, "wallet2", 150n);
    mock.release(0n, "wallet2");
    expect(mock.balances.get("wallet2")).toBe(30000n);
  });

  it("refunds after deadline", () => {
    mock.createEscrow(40000n, "wallet2", 110n);
    mock.blockHeight = 120n;
    mock.refund(0n, "wallet1");
    expect(mock.balances.get("wallet1")).toBe(1000000n);
  });
  
  it("blocks release during active dispute", () => {
    mock.createEscrow(35000n, "wallet2", 200n);
    mock.raiseDispute(0n, "wallet1");
    expect(() => mock.release(0n, "wallet2")).toThrow("ERR-DISPUTE-ACTIVE");
  });
});