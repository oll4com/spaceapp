import { describe, expect, it } from "vitest";
import {
  InMemorySpaceStore,
  createStaticCatalog,
  defaultUserLinks
} from "../src/index.js";

describe("public runtime defaults", () => {
  it("starts with generic provider, link, and source-control catalogs", () => {
    const catalog = createStaticCatalog({
      codexLbBaseUrl: "http://127.0.0.1:2458/v1"
    });
    const store = new InMemorySpaceStore({
      codexLbBaseUrl: "http://127.0.0.1:2458/v1"
    });

    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "codex-lb",
      "openai",
      "anthropic",
      "local"
    ]);
    expect(store.getProviderSettings().defaultProviderId).toBe("codex-lb");
    expect(defaultUserLinks).toEqual([]);
    expect(store.listUserLinks("owner:public", { page: 1, pageSize: 25 })).toMatchObject({
      items: [],
      total: 0
    });
    expect(store.listSourceControlConnections()).toEqual([
      expect.objectContaining({
        provider: "gitea",
        repositoryOwner: "spaceapp-owner",
        repositoryName: "spaceapp"
      }),
      expect.objectContaining({
        provider: "github",
        repositoryOwner: "spaceapp-owner",
        repositoryName: "spaceapp"
      })
    ]);

    expect(JSON.stringify({
      providers: catalog.providers,
      links: defaultUserLinks,
      sourceControl: store.listSourceControlConnections()
    })).not.toMatch(new RegExp([
      ["head", "room"].join(""),
      ["10", ".100.0."].join(""),
      ["coder-", "codex-", "rooms"].join(""),
      ["oll4com/", "space"].join("")
    ].join("|"), "i"));
  });
});
