/** Business rule shared by the update schemas: an update must name at least one field (ARCH-002). */
export function atLeastOneField(message: string): [(input: object) => boolean, string] {
  return [(input) => Object.keys(input).length > 0, message];
}
