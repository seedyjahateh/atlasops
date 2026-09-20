/**
 * Flat config. The interesting part is at the bottom: the restricted-import zones are generated
 * from tools/boundaries/layers.json rather than written out here.
 *
 * Two mechanisms enforce the same rule for different reasons. This one is the fast, local signal —
 * a forbidden import fails `pnpm lint` at the file that wrote it, before a commit. `pnpm
 * boundaries:check` is the thorough one: it walks the resolved graph and catches what lint cannot,
 * including transitive edges and imports reached through re-exports. Generating both from one
 * manifest is what stops them drifting into disagreement, which is the state in which people start
 * ignoring whichever one is noisier.
 */

import { readFileSync } from "node:fs";

import js from "@eslint/js";
import tseslint from "typescript-eslint";

const manifest = JSON.parse(readFileSync("./tools/boundaries/layers.json", "utf8"));

const packageIds = Object.keys(manifest.packages);

/** One zone per package: everything it may not import, named, with the reason attached. */
const boundaryConfigs = Object.entries(manifest.packages).map(([id, rule]) => {
  const forbiddenPackages = packageIds.filter(
    (candidate) => candidate !== id && !rule.mayImport.includes(candidate),
  );

  const forbiddenSdks = manifest.providerSdks.allowedIn.includes(id)
    ? []
    : manifest.providerSdks.patterns;

  return {
    files: [`${rule.path}/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...forbiddenPackages.map((target) => ({
              group: [target, `${target}/*`],
              message:
                `${id} may not import ${target}. Its row in tools/boundaries/layers.json lists ` +
                `[${rule.mayImport.join(", ") || "nothing"}]. Widening that row is its own change, ` +
                `with an ADR.`,
            })),
            ...forbiddenSdks.map((pattern) => ({
              group: [pattern, pattern.endsWith("/*") ? pattern : `${pattern}/*`],
              message:
                `${id} may not import a provider SDK. Only ` +
                `${manifest.providerSdks.allowedIn.join(", ")} may — everything above it depends on ` +
                `an interface, which is what lets downstream tests use the deterministic fake.`,
            })),
          ],
        },
      ],
    },
  };
});

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/fixtures/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    // This file is JavaScript and is not part of the TypeScript program, so the
    // type-aware rules have no types to work from. Linted, but not type-linted.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    languageOptions: {
      parserOptions: {
        // `allowDefaultProject` covers the config files themselves, which are not
        // part of the TypeScript program but are still worth linting.
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The repository is ESM with NodeNext resolution, so relative specifiers carry an
      // extension. Enforced because a missing one works under a bundler and fails at runtime.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // The CLI is the one place allowed to write to the process streams, because reporting a
    // violation to CI is its entire job.
    files: ["tools/boundaries/src/cli.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  ...boundaryConfigs,
);
