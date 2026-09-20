import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps,exhibits,tools}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
    // A test that passes because it silently did nothing is the failure mode this
    // repository cares about most, so an empty suite is an error rather than a pass.
    passWithNoTests: false,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      exclude: ["**/*.test.ts", "**/fixtures/**", "**/dist/**"],
    },
  },
});
