/**
 * Filesystem connector tests.
 *
 * Written against a real temporary directory rather than a mocked `fs`, because the two behaviours
 * worth testing here are both about what the filesystem actually does: a directory that cannot be
 * read, and two paths that collide into one identifier. A mock would assert that the mock was
 * called.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHashOf } from "@atlasops/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { filesystemConnector } from "./filesystem-connector.js";
import { structureAware } from "./strategy.js";

const ACL = { readableBy: ["grp_engineering"], existence: "visible" };
const NOW = (): string => "2026-05-01T00:00:00.000Z";

const roots: string[] = [];

function makeRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "atlasops-fs-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

function connect(root: string) {
  return filesystemConnector({
    root,
    strategy: structureAware({ maxTokens: 64, boundaryDepth: 2 }),
    acl: ACL,
    now: NOW,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A directory a test made unreadable may resist cleanup on some platforms. Leaving a
      // temporary directory behind is not worth failing a suite over.
    }
  }
});

describe("the filesystem connector", () => {
  it("lists the files it can read, hashed by content", async () => {
    const root = makeRoot({
      "handbook.md": "# Handbook\n\nThe refund window is thirty days.\n",
      "notes/escalation.md": "# Escalation\n\nPage the secondary.\n",
      "ignored.pdf": "not a text file",
    });

    const listing = await connect(root).list();

    expect(listing.complete).toBe(true);
    expect(listing.sources.map((source) => source.sourceId)).toEqual([
      "src_handbook.md",
      "src_notes--escalation.md",
    ]);
    expect(listing.sources[0]?.contentHash).toBe(
      contentHashOf("# Handbook\n\nThe refund window is thirty days.\n"),
    );
  });

  it("fetches the bytes the listing hashed", async () => {
    const text = "# Handbook\n\nThe refund window is thirty days.\n";
    const connector = connect(makeRoot({ "handbook.md": text }));
    await connector.list();

    const fetched = await connector.fetch("src_handbook.md" as never);
    expect(fetched.text).toBe(text);
    expect(fetched.observation.contentHash).toBe(contentHashOf(text));
    expect(fetched.observation.acl).toEqual(ACL);
  });

  describe("labels per path", () => {
    it("gives each zone its own label", async () => {
      // A connector that can only apply one label to a whole corpus can only describe a corpus
      // everybody may read — and a permission probe over such a corpus measures nothing, because
      // nothing in it is forbidden to anybody.
      const connector = filesystemConnector({
        root: makeRoot({ "public/a.md": "public", "finance/b.md": "restricted" }),
        strategy: structureAware({ maxTokens: 64, boundaryDepth: 2 }),
        aclFor: (path) =>
          path.startsWith("finance/")
            ? { readableBy: ["grp_finance"], existence: "visible" }
            : { readableBy: ["grp_everyone"], existence: "visible" },
        now: NOW,
      });
      await connector.list();

      const open = await connector.fetch("src_public--a.md" as never);
      const closed = await connector.fetch("src_finance--b.md" as never);

      expect(open.observation.acl).toEqual({ readableBy: ["grp_everyone"], existence: "visible" });
      expect(closed.observation.acl).toEqual({ readableBy: ["grp_finance"], existence: "visible" });
    });

    it("fails the fetch of an unlabelled file and leaves the rest of the crawl alone", async () => {
      // Isolation, not suppression (PRD 4.5): the unlabelled file is never ingested, so nobody can
      // retrieve it, and the labelled ones still arrive.
      const connector = filesystemConnector({
        root: makeRoot({ "public/a.md": "public", "stray.md": "unlabelled" }),
        strategy: structureAware({ maxTokens: 64, boundaryDepth: 2 }),
        aclFor: (path) => {
          if (!path.startsWith("public/")) throw new Error(`no rule covers "${path}"`);
          return { readableBy: ["grp_everyone"], existence: "visible" };
        },
        now: NOW,
      });
      const listing = await connector.list();
      expect(listing.sources).toHaveLength(2);

      await expect(connector.fetch("src_stray.md" as never)).rejects.toThrow(/no rule covers/);
      await expect(connector.fetch("src_public--a.md" as never)).resolves.toBeDefined();
    });

    it("refuses to be built with both a uniform label and a resolver", () => {
      // Two answers to one question. Better now than on the first fetch of the first crawl.
      expect(() =>
        filesystemConnector({
          root: makeRoot({}),
          strategy: structureAware({ maxTokens: 64, boundaryDepth: 2 }),
          acl: ACL,
          aclFor: () => ACL,
          now: NOW,
        }),
      ).toThrow(/exactly one/);
    });

    it("refuses to be built with neither", () => {
      expect(() =>
        filesystemConnector({
          root: makeRoot({}),
          strategy: structureAware({ maxTokens: 64, boundaryDepth: 2 }),
          now: NOW,
        }),
      ).toThrow(/exactly one/);
    });
  });

  it("refuses to fetch a source that was not in the last listing", async () => {
    const connector = connect(makeRoot({ "handbook.md": "text" }));
    await connector.list();

    await expect(connector.fetch("src_absent.md" as never)).rejects.toThrow(/not in the last/);
  });

  it("refuses two paths that would become one identifier", () => {
    // `a/b.md` and `a-b.md` both slugify to the same thing. Silently merging them would make each
    // crawl overwrite the other.
    const root = makeRoot({ "a/b.md": "one", "a--b.md": "two" });
    expect(() => connect(root).list()).toThrow(/both name source/);
  });

  it("reports a partial view rather than a short one when a directory cannot be read", async () => {
    // The failure PRD 4.2's `complete` flag exists for: a shorter listing read as truth deletes
    // every source underneath the directory that failed.
    const root = makeRoot({ "handbook.md": "text", "locked/secret.md": "text" });
    const locked = join(root, "locked");

    chmodSync(locked, 0o000);
    const listing = await connect(root).list();
    chmodSync(locked, 0o700);

    if (listing.sources.length === 2) {
      // Some platforms — Windows, and any root-owned CI container — ignore the mode change. The
      // behaviour under test cannot be produced there, and asserting it anyway would be asserting
      // the platform rather than the connector.
      expect(listing.complete).toBe(true);
      return;
    }

    expect(listing.complete).toBe(false);
    expect(listing.sources.map((source) => source.sourceId)).toEqual(["src_handbook.md"]);
  });

  it("returns an empty, complete listing for an empty directory", async () => {
    const listing = await connect(makeRoot({})).list();
    expect(listing.sources).toEqual([]);
    expect(listing.complete).toBe(true);
  });
});
