import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/browser/**"],
    reporters: [
      "default",
      [
        "junit",
        {
          outputFile: ".reports/junit.xml",
          suiteName: "Talos",
          addFileAttribute: true,
          includeConsoleOutput: false,
        },
      ],
      ...(process.env.GITHUB_ACTIONS === "true"
        ? ["github-actions" as const]
        : []),
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/api.ts", "src/types.ts"],
      reportsDirectory: "coverage",
      reporter: ["text", "lcovonly", "json", "json-summary", "html"],
      reportOnFailure: true,
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
