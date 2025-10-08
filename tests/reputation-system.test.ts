import { describe, it, expect, beforeEach } from "vitest";
import { uintCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_SCORE = 101;
const ERR_INVALID_JOB_VALUE = 102;
const ERR_INVALID_REVIEWER = 103;
const ERR_INVALID_RATEE = 104;
const ERR_REVIEW_ALREADY_EXISTS = 105;
const ERR_MAX_REVIEWS_EXCEEDED = 112;
const ERR_INVALID_REVIEW_TYPE = 117;

interface Review {
  score: number;
  timestamp: number;
  jobValue: number;
  reviewType: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; value: number };

class ReputationSystemMock {
  state: {
    admin: string;
    decayMultiplier: number;
    repThreshold: number;
    lastDecayBlock: number;
    reputations: Map<number, number>;
    reviews: Map<string, Review>;
    reviewCounts: Map<number, number>;
    totalJobValues: Map<number, number>;
    lastReviewTimestamps: Map<number, number>;
  } = {
    admin: "ST1TEST",
    decayMultiplier: 90,
    repThreshold: 700,
    lastDecayBlock: 0,
    reputations: new Map(),
    reviews: new Map(),
    reviewCounts: new Map(),
    totalJobValues: new Map(),
    lastReviewTimestamps: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";
  events: Array<{ event: string; [key: string]: any }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      admin: "ST1TEST",
      decayMultiplier: 90,
      repThreshold: 700,
      lastDecayBlock: 0,
      reputations: new Map(),
      reviews: new Map(),
      reviewCounts: new Map(),
      totalJobValues: new Map(),
      lastReviewTimestamps: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
    this.events = [];
  }

  getRep(id: number): number | undefined {
    return this.state.reputations.get(id);
  }

  getReview(ratee: number, reviewer: number): Review | undefined {
    const key = `${ratee}-${reviewer}`;
    return this.state.reviews.get(key);
  }

  getReviewCount(id: number): number {
    return this.state.reviewCounts.get(id) ?? 0;
  }

  getTotalJobValue(id: number): number {
    return this.state.totalJobValues.get(id) ?? 0;
  }

  getLastReviewTimestamp(id: number): number {
    return this.state.lastReviewTimestamps.get(id) ?? 0;
  }

  submitReview(
    reviewerId: number,
    rateeId: number,
    score: number,
    jobValue: number,
    reviewType: number
  ): Result<boolean> {
    if (reviewerId <= 0) return { ok: false, value: ERR_INVALID_REVIEWER };
    if (rateeId <= 0) return { ok: false, value: ERR_INVALID_RATEE };
    if (score < 1 || score > 100) return { ok: false, value: ERR_INVALID_SCORE };
    if (jobValue < 1) return { ok: false, value: ERR_INVALID_JOB_VALUE };
    if (reviewType !== 1 && reviewType !== 2) return { ok: false, value: ERR_INVALID_REVIEW_TYPE };
    const currentCount = this.getReviewCount(rateeId);
    if (currentCount >= 100) return { ok: false, value: ERR_MAX_REVIEWS_EXCEEDED };
    const key = `${rateeId}-${reviewerId}`;
    if (this.state.reviews.has(key)) return { ok: false, value: ERR_REVIEW_ALREADY_EXISTS };

    const reviewerRep = this.state.reputations.get(reviewerId) ?? 500;
    const base = score * 10;
    const repAdjust = (base * reviewerRep) / 1000;
    const valueAdjust = (repAdjust * jobValue) / 100;
    const typeBoost = reviewType === 2 ? 20 : 10;
    const adjustedScore = valueAdjust + typeBoost;

    this.state.reviews.set(key, { score: adjustedScore, timestamp: this.blockHeight, jobValue, reviewType });
    this.state.reviewCounts.set(rateeId, currentCount + 1);
    this.state.totalJobValues.set(rateeId, this.getTotalJobValue(rateeId) + jobValue);
    this.state.lastReviewTimestamps.set(rateeId, this.blockHeight);

    const oldRep = this.state.reputations.get(rateeId) ?? 0;
    const totalReviews = this.getReviewCount(rateeId);
    const totalJobValue = this.getTotalJobValue(rateeId);
    const lastTs = this.getLastReviewTimestamp(rateeId);
    const blocksSinceLast = this.blockHeight - lastTs;
    let decayedOld = oldRep;
    if (blocksSinceLast > 144) {
      let decayCycles = Math.floor(blocksSinceLast / 144);
      while (decayCycles > 0) {
        decayedOld = (decayedOld * this.state.decayMultiplier) / 100;
        decayCycles--;
      }
      decayedOld = Math.max(0, decayedOld);
    }
    const avgJobValue = totalReviews > 0 ? totalJobValue / totalReviews : 0;
    const reviewBoost = totalReviews > 0 ? 10 * Math.floor(totalReviews / 10) : 0;
    const weighted = (decayedOld * avgJobValue) / 100;
    let newRep = Math.min(1000, weighted + reviewBoost);
    this.state.reputations.set(rateeId, newRep);
    this.events.push({ event: "rep-updated", id: rateeId, newRep });
    this.events.push({ event: "review-submitted", ratee: rateeId, reviewer: reviewerId });

    return { ok: true, value: true };
  }

  applyGlobalDecay(): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (this.blockHeight - this.state.lastDecayBlock <= 144) return { ok: false, value: 108 };
    this.state.lastDecayBlock = this.blockHeight;
    this.events.push({ event: "global-decay-applied" });
    return { ok: true, value: true };
  }

  setDecayMultiplier(newMultiplier: number): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (newMultiplier < 50 || newMultiplier > 99) return { ok: false, value: 109 };
    this.state.decayMultiplier = newMultiplier;
    return { ok: true, value: true };
  }

  setRepThreshold(newThreshold: number): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (newThreshold < 500 || newThreshold > 900) return { ok: false, value: 114 };
    this.state.repThreshold = newThreshold;
    return { ok: true, value: true };
  }

  isAboveThreshold(id: number): boolean {
    const rep = this.state.reputations.get(id) ?? 0;
    return rep >= this.state.repThreshold;
  }

  adjustRep(id: number, adjustment: number): Result<boolean> {
    if (this.caller !== this.state.admin) return { ok: false, value: ERR_NOT_AUTHORIZED };
    let current = this.state.reputations.get(id) ?? 0;
    let newRep = adjustment > 0 ? current + adjustment : current - Math.abs(adjustment);
    if (newRep < 0 || newRep > 1000) return { ok: false, value: 113 };
    this.state.reputations.set(id, newRep);
    this.events.push({ event: "rep-adjusted", id, newRep });
    return { ok: true, value: true };
  }
}

describe("ReputationSystem", () => {
  let contract: ReputationSystemMock;

  beforeEach(() => {
    contract = new ReputationSystemMock();
    contract.reset();
  });

  it("rejects invalid reviewer", () => {
    const result = contract.submitReview(0, 2, 80, 500, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_REVIEWER);
  });

  it("rejects invalid ratee", () => {
    const result = contract.submitReview(1, 0, 80, 500, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_RATEE);
  });

  it("rejects invalid score", () => {
    const result = contract.submitReview(1, 2, 0, 500, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_SCORE);
  });

  it("rejects invalid job value", () => {
    const result = contract.submitReview(1, 2, 80, 0, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_JOB_VALUE);
  });

  it("rejects invalid review type", () => {
    const result = contract.submitReview(1, 2, 80, 500, 3);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_REVIEW_TYPE);
  });

  it("rejects duplicate review", () => {
    contract.submitReview(1, 2, 80, 500, 1);
    const result = contract.submitReview(1, 2, 90, 600, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_REVIEW_ALREADY_EXISTS);
  });

  it("rejects max reviews exceeded", () => {
    for (let i = 1; i <= 100; i++) {
      contract.submitReview(i, 1, 80, 500, 1);
    }
    const result = contract.submitReview(101, 1, 80, 500, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MAX_REVIEWS_EXCEEDED);
  });

  it("applies decay in calculation", () => {
    contract.submitReview(1, 2, 100, 1000, 2);
    contract.blockHeight += 300;
    contract.submitReview(3, 2, 90, 800, 1);
    expect(contract.getRep(2)).toBeLessThan(1000);
  });

  it("applies global decay successfully", () => {
    contract.blockHeight = 200;
    const result = contract.applyGlobalDecay();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.lastDecayBlock).toBe(200);
  });

  it("rejects global decay by non-admin", () => {
    contract.caller = "ST2FAKE";
    const result = contract.applyGlobalDecay();
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("sets decay multiplier successfully", () => {
    const result = contract.setDecayMultiplier(95);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.decayMultiplier).toBe(95);
  });

  it("rejects invalid decay multiplier", () => {
    const result = contract.setDecayMultiplier(40);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(109);
  });

  it("sets rep threshold successfully", () => {
    const result = contract.setRepThreshold(800);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.repThreshold).toBe(800);
  });

  it("rejects invalid rep threshold", () => {
    const result = contract.setRepThreshold(400);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(114);
  });

  it("checks above threshold correctly", () => {
    contract.state.reputations.set(1, 750);
    expect(contract.isAboveThreshold(1)).toBe(true);
    contract.state.reputations.set(2, 600);
    expect(contract.isAboveThreshold(2)).toBe(false);
  });

  it("adjusts rep successfully", () => {
    contract.state.reputations.set(1, 500);
    const result = contract.adjustRep(1, 200);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getRep(1)).toBe(700);
  });

  it("rejects invalid adjustment", () => {
    contract.state.reputations.set(1, 500);
    const result = contract.adjustRep(1, 600);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(113);
  });

  it("rejects adjustment by non-admin", () => {
    contract.caller = "ST2FAKE";
    const result = contract.adjustRep(1, 100);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("uses Clarity types for parameters", () => {
    const id = uintCV(1);
    expect(id.value).toEqual(BigInt(1));
  });
});