# Lint compiler API

Application builds and typechecks use the root TypeScript 7 native compiler.
TypeScript 7 does not expose the JavaScript compiler API used by typescript-eslint.
This private, separately locked prefix keeps the parser on its supported TypeScript
6 compiler and prevents npm workspace hoisting from resolving it against TypeScript 7.

`npm run lint` installs this toolchain with `npm ci` before loading ESLint.
For a scoped ESLint invocation, first run `npm --prefix scripts/lint-tools ci
--ignore-scripts --no-audit --no-fund`, then invoke the root ESLint executable.
The root `typescript-api` alias supplies the same supported API to structural
repository tests; it is never the application build compiler.
