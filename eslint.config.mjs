// ESLint baseline (plan item 3.5). Every rule reports a warning only, so `npm run lint`
// never blocks work; it measures the current state. Once the count is stable, rules
// can become errors for new code. Formatting is not linted: a mass reformat would
// touch protected terminal and room-switch code.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Turns every configured rule severity into "warn". */
function warnOnly(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    const rules = {};
    for (const [name, value] of Object.entries(config.rules)) {
      if (value === "off" || value === 0 || (Array.isArray(value) && (value[0] === "off" || value[0] === 0))) rules[name] = value;
      else rules[name] = Array.isArray(value) ? ["warn", ...value.slice(1)] : "warn";
    }
    return { ...config, rules };
  });
}

export default [
  {
    ignores: [
      "**/node_modules/**", "**/dist/**", "**/dist-*/**", "**/build/**", "**/coverage/**",
      "var/**", "backups/**", "bin/**", "secrets/**", "deploy/**",
      "apps/mobile/**", "apps/desktop/release/**", "**/*.min.js", "apps/web/public/**"
    ]
  },
  ...warnOnly([
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      rules: {
        // TypeScript checks these already.
        "no-undef": "off",
        "no-redeclare": "off"
      }
    },
    {
      files: ["apps/web/src/**/*.{ts,tsx}"],
      plugins: { "react-hooks": reactHooks },
      rules: {
        "react-hooks/rules-of-hooks": "warn",
        "react-hooks/exhaustive-deps": "warn"
      }
    }
  ]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } }
  }
];
