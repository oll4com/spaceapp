import { describe, expect, it } from "vitest";
import { matchLink } from "../src/instance-link/routes.js";

// Plan clipboard:zqVWdClsx_pA step 1: space_remote finds a link by the short name panes and the operator use ("spaceapp-hz").
const link = (id: string, label: string, origin: string) => ({ id, label, origins: [origin] });
const links = [link("link:6g5VWWBKAn8JNuMo", "Hetzner", "https://spaceapp-hz.hosting.example"), link("link:b", "vm207", "https://space.hosting.example:4911"),
  link("link:c", "lab", "https://lab-1.example:4911"), link("link:d", "lab two", "https://lab-1.other:4911")];

describe("matchLink", () => {
  it("finds a link by id, label, URL, host, host:port, and the first label of its host, case-insensitive", () => {
    for (const ref of ["link:6g5VWWBKAn8JNuMo", "hetzner", "HETZNER", "https://spaceapp-hz.hosting.example/", "spaceapp-hz.hosting.example", "spaceapp-hz.hosting.example:443", "spaceapp-hz", " SpaceApp-HZ "])
      expect(matchLink(links, ref)).toEqual({ link: links[0], matches: 1 });
    expect(matchLink(links, "space").link).toBe(links[1]);
  });

  it("a label wins over a host label; more than one match is none, with the count; no match is zero", () => {
    expect(matchLink([...links, link("link:e", "spaceapp-hz", "https://other.example")], "spaceapp-hz").link?.id).toBe("link:e");
    expect(matchLink(links, "lab-1")).toEqual({ link: null, matches: 2 });
    expect(matchLink(links, "nope")).toEqual({ link: null, matches: 0 });
    expect(matchLink(links, "hosting")).toEqual({ link: null, matches: 0 });
  });

  it("a whole word of the label or of the host's first label names it, last (23/11: \"hz\" for example.invalid)", () => {
    expect(matchLink(links, "hz")).toEqual({ link: links[0], matches: 1 });
    expect(matchLink(links, "HZ").link).toBe(links[0]);
    expect(matchLink(links, "two").link).toBe(links[3]);
    expect(matchLink([...links, link("link:f", "hz backup", "https://b.example")], "hz")).toEqual({ link: null, matches: 2 });
    expect(matchLink(links, "spaceapp").link).toBe(links[0]);
  });
});
