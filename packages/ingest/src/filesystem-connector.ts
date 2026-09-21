/**
 * A connector over a directory of files (PRD 4.2).
 *
 * The first connector in the repository that reads something real. It exists here rather than in an
 * application because PRD 11.2 puts connectors in `ingest`, and because two applications need it —
 * the worker crawls a corpus and the evaluation runner has to ingest one before it can measure
 * anything. A connector duplicated in two applications is two connectors, and they diverge.
 *
 * **A directory it could not read makes the listing incomplete rather than empty.** That is the
 * whole reason `ConnectorListing.complete` exists: an unreadable subdirectory produces a shorter
 * listing, and a shorter listing read as truth deletes every source underneath it. This connector
 * reports what it managed to read and says the view is partial, which makes the corpus withhold the
 * deletions instead of acting on a crawl that half-failed.
 *
 * **Identifiers are derived from the path and collisions are refused.** Two files whose paths
 * slugify to the same identifier would silently become one source, with each crawl overwriting the
 * other — so the listing fails loudly instead. That is a worse day for whoever named the files and
 * a much better one than the alternative.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { AtlasOpsError, contentHashOf, formatSourceId, type SourceId } from "@atlasops/contracts";
import type { ConnectorListing, ListedSource } from "@atlasops/corpus";

import type { Connector, FetchedSource } from "./connector.js";
import type { ChunkStrategy } from "./strategy.js";

export interface FilesystemConnectorOptions {
  readonly root: string;
  readonly strategy: ChunkStrategy;
  /** The label every file under this root carries. Unresolvable here is a hard error (PRD 6.1). */
  readonly acl: unknown;
  readonly name?: string;
  /** Lower-case, with the dot. Defaults to Markdown and plain text. */
  readonly extensions?: readonly string[];
  /** Wall-clock time, injected so a crawl is reproducible in a test. */
  readonly now: () => string;
}

const DEFAULT_EXTENSIONS = [".md", ".txt"] as const;

/**
 * A path becomes an identifier, or the crawl stops.
 *
 * The identifier grammar in `contracts` is deliberately narrow, so a path that cannot be expressed
 * in it is a file somebody has to rename. Truncating or hashing instead would produce an
 * identifier nobody can trace back to a document.
 */
function sourceIdFor(relativePath: string): SourceId {
  const slug = relativePath
    .split(sep)
    .join("/")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]/g, "-")
    .replace(/\//g, "--")
    .replace(/^[^a-z0-9]+/, "");

  if (slug.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `"${relativePath}" has no characters an identifier may contain`,
      "connector.sourceId",
    );
  }
  return formatSourceId(slug);
}

interface Walked {
  readonly files: readonly string[];
  /** True when every directory under the root was readable. */
  readonly complete: boolean;
}

function walk(root: string, extensions: readonly string[]): Walked {
  const files: string[] = [];
  let complete = true;

  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Not fatal, and not silently skipped either: the listing says it is partial, and the
      // corpus then withholds deletions for everything it did not see.
      complete = false;
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
        files.push(path);
      }
    }
  };

  visit(root);
  return { files: files.sort(), complete };
}

export function filesystemConnector(options: FilesystemConnectorOptions): Connector {
  const name = options.name ?? "filesystem";
  const extensions = options.extensions ?? [...DEFAULT_EXTENSIONS];

  /** Path per identifier, rebuilt on every listing so a renamed file is not served from memory. */
  const paths = new Map<SourceId, string>();

  return {
    name,
    strategy: options.strategy,

    list: (): Promise<ConnectorListing> => {
      const walked = walk(options.root, extensions);
      const sources: ListedSource[] = [];
      paths.clear();

      for (const path of walked.files) {
        const sourceId = sourceIdFor(relative(options.root, path));
        const existing = paths.get(sourceId);
        if (existing !== undefined) {
          throw new AtlasOpsError(
            "VALIDATION",
            `"${existing}" and "${path}" both name source ${sourceId}. Two files sharing an ` +
              `identifier become one source, and each crawl overwrites the other.`,
            "connector.sourceId",
          );
        }
        paths.set(sourceId, path);
        sources.push({ sourceId, contentHash: contentHashOf(readFileSync(path, "utf8")) });
      }

      return Promise.resolve({
        connector: name,
        observedAt: options.now(),
        complete: walked.complete,
        sources,
      });
    },

    fetch: (sourceId: SourceId): Promise<FetchedSource> => {
      const path = paths.get(sourceId);
      if (path === undefined) {
        return Promise.reject(new Error(`${sourceId} was not in the last listing from ${name}`));
      }

      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (cause) {
        // One unreadable file fails alone (PRD 4.5). The rest of the crawl continues.
        return Promise.reject(new Error(`could not read ${path}: ${(cause as Error).message}`));
      }

      return Promise.resolve({
        text,
        observation: {
          sourceId,
          contentHash: contentHashOf(text),
          observedAt: options.now(),
          effectiveDate: null,
          upstreamRevision: null,
          acl: options.acl,
        },
      });
    },
  };
}
