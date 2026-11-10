/** Business rule shared by the update schemas: an update must name at least one field (ARCH-002). */
export function atLeastOneField(message: string): [(input: object) => boolean, string] {
  return [(input) => Object.keys(input).length > 0, message];
}

/** Business rule shared by update schemas with named fields: at least one of them is set; null counts (ARCH-002). */
export function atLeastOneOf(fields: readonly string[], message: string): [(input: object) => boolean, string] {
  return [(input) => fields.some((field) => (input as Record<string, unknown>)[field] !== undefined), message];
}
