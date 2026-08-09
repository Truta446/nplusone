import type { Options, ResolvedOptions } from "./types.js";

function defaults(): ResolvedOptions {
  return {
    threshold: 5,
    duplicateThreshold: 2,
    mode: "warn",
    statements: undefined,
    ignore: [],
    ignoreCallSites: [],
    captureStack: true,
    stackDepth: 30,
    onFinding: undefined,
    reporter: undefined,
    enabled: process.env["NODE_ENV"] !== "production",
  };
}

let current: ResolvedOptions = defaults();

/** Merges `options` into the active configuration. */
export function configure(options: Options): ResolvedOptions {
  current = {
    threshold: options.threshold ?? current.threshold,
    duplicateThreshold: options.duplicateThreshold ?? current.duplicateThreshold,
    mode: options.mode ?? current.mode,
    statements: options.statements ?? current.statements,
    ignore: options.ignore ?? current.ignore,
    ignoreCallSites: options.ignoreCallSites ?? current.ignoreCallSites,
    captureStack: options.captureStack ?? current.captureStack,
    stackDepth: options.stackDepth ?? current.stackDepth,
    onFinding: options.onFinding ?? current.onFinding,
    reporter: options.reporter ?? current.reporter,
    enabled: options.enabled ?? current.enabled,
  };
  return current;
}

export function getOptions(): ResolvedOptions {
  return current;
}

/**
 * Replaces the configuration wholesale with a snapshot taken from
 * {@link getOptions}. Used to restore state after a temporary override.
 */
export function restoreConfig(snapshot: ResolvedOptions): ResolvedOptions {
  current = snapshot;
  return current;
}

/** Restores the built-in defaults. Mostly useful between tests. */
export function resetConfig(): ResolvedOptions {
  current = defaults();
  return current;
}
