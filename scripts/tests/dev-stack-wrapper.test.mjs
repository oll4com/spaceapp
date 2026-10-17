import test from "node:test";
import assert from "node:assert/strict";
import { openCodeWrapper } from "../dev-stack-wrapper.mjs";

test("wrapper pins its binary and provider state and clears inherited credentials", () => {
  const wrapper = openCodeWrapper({ stateDir: "/owned/repo/.dev-stack", project: "space-dev-test" }, "/node22/bin/node");
  assert.match(wrapper, /exec \/usr\/bin\/env -i /);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
    assert.match(wrapper, new RegExp(`${name}='/owned/repo/\\.dev-stack/`));
  }
  assert.match(wrapper, /vendor\/node_modules\/\.bin\/opencode/);
  assert.doesNotMatch(wrapper, /\/var\/lib\/spaceapp|\/opt\/spaceapp|API_KEY|--global/);
  assert.match(wrapper, /not certify a working model/);
  for (const key of ["OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"]) {
    assert.ok(wrapper.includes(`${key}='1'`));
  }
});

test("quotes in checkout paths cannot become wrapper shell syntax", () => {
  const wrapper = openCodeWrapper({ stateDir: "/owned/it's a repo/.dev-stack", project: "space-dev-test" });
  assert.ok(wrapper.includes(`'/owned/it'"'"'s a repo/.dev-stack/vendor/node_modules/.bin/opencode'`));
  assert.ok(wrapper.endsWith(' "$@"\n'));
});
