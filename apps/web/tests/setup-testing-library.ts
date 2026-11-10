import { beforeEach } from "vitest";
import { configure } from "@testing-library/react";

// public-host is shared by many agents. Under that load a correct render can take longer than the
// 1 s default of findBy* and waitFor (five web tests failed only in loaded full runs on
// 2026-10-12). Waits still end as soon as their condition holds.
configure({ asyncUtilTimeout: 5_000 });

// The Nous dock remembers what the operator opened per device (space.nous.ui.*); every test starts from the defaults.
beforeEach(() => {
  if (typeof localStorage === "undefined") return;
  for (const key of Object.keys(localStorage)) if (key.startsWith("space.nous.ui.")) localStorage.removeItem(key);
});
