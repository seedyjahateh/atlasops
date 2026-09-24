/**
 * Access-manifest tests.
 *
 * The behaviour that matters is the refusal. Every other rule here is bookkeeping around one
 * decision: a path no rule covers must stop the fetch rather than acquire a label, because the
 * alternative — any default at all — means the day somebody adds a document and forgets the
 * manifest, that document becomes readable by whoever the default names. PRD 6.1 calls that turning
 * "unknown" into "public"; the tests below are what stop it.
 */

import { isAtlasOpsError } from "@atlasops/contracts";
import { describe, expect, it } from "vitest";

import { aclFromManifest, parseAclManifest } from "./acl-manifest.js";

const MANIFEST = {
  rules: [
    { prefix: "public/", label: { readableBy: ["grp_everyone"], existence: "visible" } },
    { prefix: "finance/", label: { readableBy: ["grp_finance"], existence: "visible" } },
    {
      prefix: "finance/public-summary.md",
      label: { readableBy: ["grp_everyone"], existence: "visible" },
    },
  ],
};

describe("parsing", () => {
  it("accepts a manifest with rules", () => {
    expect(parseAclManifest(MANIFEST).rules).toHaveLength(3);
  });

  it("rejects one with no rules, which would refuse every path", () => {
    expect(() => parseAclManifest({ rules: [] })).toThrow(/non-empty array/);
  });

  it("rejects a rule with no label", () => {
    // A rule that names a prefix and no label is a path the manifest appears to cover and does
    // not — worse than no rule, because a reader checking coverage would count it.
    expect(() => parseAclManifest({ rules: [{ prefix: "public/" }] })).toThrow(/label is missing/);
  });

  it("rejects a duplicated prefix", () => {
    // Which label applies would depend on array order, and a permission that depends on array
    // order is not a permission.
    expect(() =>
      parseAclManifest({
        rules: [
          { prefix: "a/", label: { readableBy: ["grp_x"], existence: "visible" } },
          { prefix: "a/", label: { readableBy: ["grp_y"], existence: "visible" } },
        ],
      }),
    ).toThrow(/appears twice/);
  });
});

describe("resolution", () => {
  const resolve = aclFromManifest(parseAclManifest(MANIFEST));

  it("labels a path from its zone", () => {
    expect(resolve("public/handbook.md")).toEqual({
      readableBy: ["grp_everyone"],
      existence: "visible",
    });
  });

  it("lets the longest prefix win, so one file can be lifted out of its zone", () => {
    expect(resolve("finance/quarter-close.md")).toEqual({
      readableBy: ["grp_finance"],
      existence: "visible",
    });
    expect(resolve("finance/public-summary.md")).toEqual({
      readableBy: ["grp_everyone"],
      existence: "visible",
    });
  });

  it("accepts Windows separators, because a crawl on Windows produces them", () => {
    expect(resolve("public\\handbook.md")).toEqual({
      readableBy: ["grp_everyone"],
      existence: "visible",
    });
  });

  it("refuses a path no rule covers, and says so as an ACL failure", () => {
    // The whole design. Not `VALIDATION`: this is the one error class PRD 9.4 says has no degraded
    // mode, and the code is what a caller branches on to fail closed.
    let thrown: unknown;
    try {
      resolve("engineering/oncall.md");
    } catch (error) {
      thrown = error;
    }

    expect(isAtlasOpsError(thrown)).toBe(true);
    expect(isAtlasOpsError(thrown) && thrown.code).toBe("ACL_UNRESOLVED");
    expect((thrown as Error).message).toMatch(/not labelled "public" by default/);
  });

  it("names the prefixes it does know, because the fix is always to add a rule", () => {
    const message = (() => {
      try {
        resolve("nowhere/x.md");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();

    for (const prefix of ["public/", "finance/", "finance/public-summary.md"]) {
      expect(message).toContain(`"${prefix}"`);
    }
  });
});
