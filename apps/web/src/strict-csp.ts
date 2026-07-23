type ZodConfigHost = typeof globalThis & {
  __zod_globalConfig?: Record<string, unknown> & { jitless?: boolean };
};

export function enableStrictCspCompatibility() {
  const host = globalThis as ZodConfigHost;
  const config = host.__zod_globalConfig ??= {};
  config.jitless = true;
}
