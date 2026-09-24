/**
 * Access labels per source, declared beside a corpus rather than inside it.
 *
 * A connector that applies one label to a whole directory can only describe a corpus everybody may
 * read. Nothing in such a corpus is forbidden to anybody, so a permission probe over it is
 * arithmetic rather than evidence: the leak count is zero because there was nothing to leak.
 * PRD 6.2's pre-filter and PRD 6.4's existence oracle both need a corpus with zones.
 *
 * **The manifest sits outside the corpus root, not in it.** A label file inside the crawl would
 * become a source, be chunked, and be retrievable — an access-control policy answering questions
 * about itself. Keeping it outside also keeps ADR 0003 true: bytes decide identity, so a label
 * change produces no new version.
 *
 * **There is no default label, and an uncovered path is a hard failure.** That is the whole design.
 * A default is how "unknown" becomes "public" (PRD 6.1): the day somebody adds a file to a corpus
 * and forgets the manifest, the choice is between a crawl that stops and a document that quietly
 * becomes readable by everyone. This stops.
 */

import { readFileSync } from "node:fs";

import { AtlasOpsError } from "@atlasops/contracts";

export interface AclRule {
  /**
   * A path prefix, relative to the corpus root, with `/` separators.
   *
   * A prefix rather than a glob. Globs need a matcher, matchers have precedence rules, and the
   * question this file answers — which zone is this document in — is answered by a directory in
   * every corpus this is meant for. The longest matching prefix wins, so a single file can be
   * lifted out of its directory's zone by naming it exactly.
   */
  readonly prefix: string;
  /** The label, validated downstream by `contracts` rather than here. */
  readonly label: unknown;
}

export interface AclManifest {
  readonly rules: readonly AclRule[];
}

/** Parses the manifest file, refusing shapes that would silently label nothing. */
export function parseAclManifest(value: unknown, where = "acl-manifest"): AclManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AtlasOpsError("VALIDATION", `${where} must be an object`, where);
  }

  const rules = (value as Record<string, unknown>).rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${where}.rules must be a non-empty array. A manifest with no rules covers no path, and ` +
        `every fetch under it would fail — which is safe but useless.`,
      `${where}.rules`,
    );
  }

  const parsed: AclRule[] = rules.map((rule, index) => {
    const at = `${where}.rules[${String(index)}]`;
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new AtlasOpsError("VALIDATION", `${at} must be an object`, at);
    }
    const record = rule as Record<string, unknown>;
    const prefix = record.prefix;
    if (typeof prefix !== "string") {
      throw new AtlasOpsError("VALIDATION", `${at}.prefix must be a string`, `${at}.prefix`);
    }
    if (record.label === undefined) {
      throw new AtlasOpsError(
        "VALIDATION",
        `${at}.label is missing. A rule without a label is a path the manifest appears to cover ` +
          `and does not, which is worse than no rule at all.`,
        `${at}.label`,
      );
    }
    return { prefix, label: record.label };
  });

  const seen = new Set<string>();
  for (const rule of parsed) {
    if (seen.has(rule.prefix)) {
      throw new AtlasOpsError(
        "VALIDATION",
        `${where}: the prefix "${rule.prefix}" appears twice. Which label applies would then ` +
          `depend on array order, and a permission that depends on array order is not a permission.`,
        `${where}.rules`,
      );
    }
    seen.add(rule.prefix);
  }

  return { rules: parsed };
}

/**
 * Reads and parses a manifest file.
 *
 * Here rather than in each application for the reason PRD 11.2 gives about connectors: three
 * applications need it, and three copies of a permission loader are three chances for one of them
 * to be lenient.
 */
export function loadAclManifest(path: string): AclManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new AtlasOpsError(
      "VALIDATION",
      `could not read the access manifest at "${path}": ${(cause as Error).message}`,
      "acl.manifest",
    );
  }
  return parseAclManifest(raw, path);
}

/**
 * Longest matching prefix, or a refusal.
 *
 * Returns the label for a path relative to the corpus root. The refusal names the path and the
 * prefixes that exist, because the fix is always to add a rule and the message should say which
 * ones were tried.
 */
export function aclFromManifest(manifest: AclManifest): (relativePath: string) => unknown {
  const rules = [...manifest.rules].sort((a, b) => b.prefix.length - a.prefix.length);

  return (relativePath: string): unknown => {
    const path = relativePath.split("\\").join("/");
    const rule = rules.find(
      (candidate) => path === candidate.prefix || path.startsWith(candidate.prefix),
    );

    if (rule === undefined) {
      throw new AtlasOpsError(
        "ACL_UNRESOLVED",
        `no access rule covers "${path}". The manifest declares ` +
          `${rules.map((each) => `"${each.prefix}"`).join(", ")}. A corpus file with no rule is ` +
          `not labelled "public" by default — that is how unknown becomes readable (PRD 6.1) — so ` +
          `the crawl stops until somebody decides who may read it.`,
        "acl.manifest",
      );
    }

    return rule.label;
  };
}
