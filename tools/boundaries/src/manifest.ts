/**
 * The layer manifest: load it, and refuse to proceed on a malformed one.
 *
 * Validation is hand-written rather than delegated to a schema library on purpose. This module is
 * the thing that enforces every other module's dependencies, so it is the one place in the
 * repository that must not acquire a dependency to do its job — a boundary checker that can be
 * disabled by a broken transitive install is not a boundary checker.
 */

import { readFileSync } from "node:fs";

export interface PackageRule {
  readonly id: string;
  readonly path: string;
  readonly layer: number;
  readonly owns: string;
  readonly mayImport: readonly string[];
}

export interface GroupRule {
  readonly id: string;
  readonly pathPrefix: string;
  readonly layer: number;
  readonly owns: string;
  readonly mayImportAnyPackage: boolean;
  readonly mayImportGroups: readonly string[];
}

export interface ProviderSdkRule {
  readonly allowedIn: readonly string[];
  readonly patterns: readonly string[];
}

/**
 * The same containment, keyed on the host rather than the package name.
 *
 * `providerSdks` catches `import OpenAI from "openai"`. It cannot catch `fetch("https://api.openai
 * .com/v1/…")`, because that is not an import — so a provider adapter written without an SDK would
 * leave the gateway boundary enforced against a shape nobody uses. See ADR 0006.
 */
export interface ProviderEndpointRule {
  readonly allowedIn: readonly string[];
  /** Hosts, matched as substrings of the file's text. */
  readonly patterns: readonly string[];
}

export interface Manifest {
  readonly version: number;
  readonly layerNames: readonly string[];
  readonly packages: readonly PackageRule[];
  readonly groups: readonly GroupRule[];
  readonly providerSdks: ProviderSdkRule;
  readonly providerEndpoints: ProviderEndpointRule;
}

export class ManifestError extends Error {
  public override readonly name = "ManifestError";
}

function fail(message: string): never {
  throw new ManifestError(message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${where} must be an array of strings`);
  }
  return value as string[];
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${where} must be an integer`);
  }
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${where} must be a non-empty string`);
  }
  return value;
}

export function parseManifest(source: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    fail(`layers.json is not valid JSON: ${(cause as Error).message}`);
  }

  const root = asRecord(raw, "layers.json");
  const version = asNumber(root.version, "version");
  if (version !== 1)
    fail(`unsupported manifest version ${String(version)}; this checker understands 1`);

  const layerNames = asStringArray(root.layerNames, "layerNames");

  const packagesRecord = asRecord(root.packages, "packages");
  const packages: PackageRule[] = Object.entries(packagesRecord).map(([id, value]) => {
    const entry = asRecord(value, `packages["${id}"]`);
    const layer = asNumber(entry.layer, `packages["${id}"].layer`);
    if (layer < 0 || layer >= layerNames.length) {
      fail(`packages["${id}"].layer is ${String(layer)}, outside the declared layerNames`);
    }
    return {
      id,
      path: asString(entry.path, `packages["${id}"].path`),
      layer,
      owns: asString(entry.owns, `packages["${id}"].owns`),
      mayImport: asStringArray(entry.mayImport, `packages["${id}"].mayImport`),
    };
  });

  const known = new Set(packages.map((pkg) => pkg.id));
  for (const pkg of packages) {
    for (const dependency of pkg.mayImport) {
      if (!known.has(dependency)) {
        fail(
          `packages["${pkg.id}"].mayImport names "${dependency}", which is not a declared package`,
        );
      }
      if (dependency === pkg.id)
        fail(`packages["${pkg.id}"] may not declare itself as a dependency`);
    }
  }

  /**
   * A permitted edge must also go downward. Without this the manifest could declare a legal cycle
   * and the checker would enforce it faithfully — the rule in PRD 11.2 is that dependencies flow
   * downward only, so the manifest is held to it as well as the code.
   */
  const layerOf = new Map(packages.map((pkg) => [pkg.id, pkg.layer]));
  for (const pkg of packages) {
    for (const dependency of pkg.mayImport) {
      const target = layerOf.get(dependency) ?? -1;
      if (target >= pkg.layer) {
        fail(
          `packages["${pkg.id}"] (layer ${String(pkg.layer)}) may not import "${dependency}" ` +
            `(layer ${String(target)}): permitted edges must go strictly downward`,
        );
      }
    }
  }

  const groupsRecord = asRecord(root.groups, "groups");
  const groups: GroupRule[] = Object.entries(groupsRecord).map(([id, value]) => {
    const entry = asRecord(value, `groups["${id}"]`);
    return {
      id,
      pathPrefix: asString(entry.pathPrefix, `groups["${id}"].pathPrefix`),
      layer: asNumber(entry.layer, `groups["${id}"].layer`),
      owns: asString(entry.owns, `groups["${id}"].owns`),
      mayImportAnyPackage: entry.mayImportAnyPackage === true,
      mayImportGroups: asStringArray(entry.mayImportGroups, `groups["${id}"].mayImportGroups`),
    };
  });

  const sdkRecord = asRecord(root.providerSdks, "providerSdks");
  const providerSdks: ProviderSdkRule = {
    allowedIn: asStringArray(sdkRecord.allowedIn, "providerSdks.allowedIn"),
    patterns: asStringArray(sdkRecord.patterns, "providerSdks.patterns"),
  };
  for (const id of providerSdks.allowedIn) {
    if (!known.has(id))
      fail(`providerSdks.allowedIn names "${id}", which is not a declared package`);
  }

  /**
   * Required, not optional-with-a-default.
   *
   * An absent block would mean "no endpoint is restricted", which reads in CI exactly like a
   * passing rule. A manifest that forgets this has to say so out loud.
   */
  const endpointRecord = asRecord(root.providerEndpoints, "providerEndpoints");
  const providerEndpoints: ProviderEndpointRule = {
    allowedIn: asStringArray(endpointRecord.allowedIn, "providerEndpoints.allowedIn"),
    patterns: asStringArray(endpointRecord.patterns, "providerEndpoints.patterns"),
  };
  for (const id of providerEndpoints.allowedIn) {
    if (!known.has(id))
      fail(`providerEndpoints.allowedIn names "${id}", which is not a declared package`);
  }

  return { version, layerNames, packages, groups, providerSdks, providerEndpoints };
}

export function loadManifest(path: string): Manifest {
  return parseManifest(readFileSync(path, "utf8"));
}
