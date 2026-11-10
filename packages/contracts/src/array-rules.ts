/** Business rule shared by list schemas: no value may appear twice (ARCH-002). Spread into `.refine(...)`. */
export function noRepeatedValues(): [(values: readonly unknown[]) => boolean];
export function noRepeatedValues(message: string): [(values: readonly unknown[]) => boolean, string];
export function noRepeatedValues(message?: string): [(values: readonly unknown[]) => boolean, string?] {
  const check = (values: readonly unknown[]) => new Set(values).size === values.length;
  return message === undefined ? [check] : [check, message];
}
