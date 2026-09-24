/**
 * Dataset-validation tests (P14b).
 *
 * Each of these is a labelling mistake I could make, and every one of them is silent downstream:
 * the metrics all compute, the build stays green, and the numbers describe something other than
 * what their names say. That is the whole reason this file exists rather than a careful read-through
 * of the labels.
 *
 * The two that matter most are mirror images. A probe that forbids a chunk the principal may read
 * turns an ordinary retrieval into a leak — and a failing leak gate invites somebody to loosen the
 * gate. A relevance label on material the principal may *not* read asks the system to retrieve what
 * PRD 6.2 requires it to withhold, so obeying the pre-filter scores as a miss. A dataset can quietly
 * demand a leak, and nothing downstream would say so.
 */

import { describe, expect, it } from "vitest";

import { checkDatasets, type DatasetUnderCheck, type InventoryRef } from "./validate.js";

const SNAPSHOT = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

const INVENTORY: InventoryRef = {
  corpusSnapshot: SNAPSHOT,
  sources: [
    {
      sourceId: "src_public--handbook.md",
      readableBy: ["grp_everyone"],
      existence: "visible",
      chunks: [{ chunkId: "chk_public_0" }, { chunkId: "chk_public_1" }],
    },
    {
      sourceId: "src_finance--quarter-close.md",
      readableBy: ["grp_finance"],
      existence: "visible",
      chunks: [{ chunkId: "chk_finance_0" }],
    },
  ],
};

const MEMBERS = {
  prn_reader: ["grp_everyone"],
  prn_frank: ["grp_everyone", "grp_finance"],
};

function dataset(item: Partial<DatasetUnderCheck["items"][number]>): DatasetUnderCheck {
  return {
    name: "relevance",
    corpusSnapshot: SNAPSHOT,
    items: [{ id: "rel-001", principal: "prn_reader", wanted: [], forbidden: [], ...item }],
  };
}

describe("labels are checked against the corpus they claim to describe", () => {
  it("passes a dataset whose labels are readable by the principal who asks", () => {
    expect(checkDatasets([dataset({ wanted: ["chk_public_0"] })], INVENTORY, MEMBERS)).toEqual([]);
  });

  it("catches a pin to a corpus that is no longer on disk", () => {
    const stale: DatasetUnderCheck = { ...dataset({}), corpusSnapshot: "sha256:deadbeef" };
    const problems = checkDatasets([stale], INVENTORY, MEMBERS);

    expect(problems[0]?.message).toMatch(/wrong denominator/);
  });

  it("catches a label pointing at a chunk that no longer exists", () => {
    // Nothing downstream reports this: recall simply never finds it and the system scores worse
    // than it is, which reads as a retrieval problem rather than a dataset problem.
    const problems = checkDatasets([dataset({ wanted: ["chk_gone_0"] })], INVENTORY, MEMBERS);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/no longer exists/);
  });

  it("catches a probe that forbids something the principal may read", () => {
    const problems = checkDatasets(
      [dataset({ principal: "prn_frank", forbidden: ["chk_finance_0"] })],
      INVENTORY,
      MEMBERS,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/counted as a leak/);
  });

  it("catches a relevance label on material the principal may not read", () => {
    // The mirror mistake, and the more dangerous one: the dataset would be asking the system to
    // leak, and a system that obeyed PRD 6.2 would score as having missed.
    const problems = checkDatasets(
      [dataset({ principal: "prn_reader", wanted: ["chk_finance_0"] })],
      INVENTORY,
      MEMBERS,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/requires it to withhold/);
  });

  it("catches a principal who is in no group map entry", () => {
    // Group resolution fails closed (PRD 9.4), so every run of the item errors rather than
    // measuring — but only once somebody runs it.
    const problems = checkDatasets([dataset({ principal: "prn_nobody" })], INVENTORY, MEMBERS);

    expect(problems[0]?.message).toMatch(/no group map entry/);
  });

  it("allows a probe to forbid a chunk from a zone the principal partly shares", () => {
    // prn_frank holds grp_everyone and grp_finance; the engineering zone is absent from the
    // inventory here, so the finance chunk is readable and the public one is too. Nothing to flag.
    expect(
      checkDatasets(
        [dataset({ principal: "prn_frank", wanted: ["chk_public_0", "chk_finance_0"] })],
        INVENTORY,
        MEMBERS,
      ),
    ).toEqual([]);
  });
});
