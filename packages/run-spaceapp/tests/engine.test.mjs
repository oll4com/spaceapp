import assert from "node:assert";
import { describe, test } from "node:test";
import {
  composeBinary,
  defaultEngine,
  inspectPodmanMachine,
  isPodmanVersionSupported,
  isSupportedEngine,
  listPodmanMachines,
  minimumPodmanVersion,
  normalizeEngine,
  parseEngineVersion,
  podmanMachineResizeGuidance,
  podmanMachineResourceInfo
} from "../src/engine.mjs";

describe("engine support", () => {
  test("default engine is docker", () => {
    assert.equal(defaultEngine(), "docker");
  });

  test("only docker and podman are supported", () => {
    assert.equal(isSupportedEngine("docker"), true);
    assert.equal(isSupportedEngine("podman"), true);
    assert.equal(isSupportedEngine("PodMan"), false);
    assert.equal(isSupportedEngine("nerdctl"), false);
    assert.equal(isSupportedEngine(""), false);
  });

  test("normalizeEngine accepts lower-case supported values", () => {
    assert.equal(normalizeEngine("docker"), "docker");
    assert.equal(normalizeEngine("Podman"), "podman");
    assert.equal(normalizeEngine("  PODMAN  "), "podman");
  });

  test("normalizeEngine rejects unsupported values", () => {
    assert.throws(() => normalizeEngine("nerdctl"), /Unsupported SpaceApp container engine/);
    assert.throws(() => normalizeEngine(""), /Unsupported SpaceApp container engine/);
  });

  test("composeBinary mirrors the normalized engine", () => {
    assert.equal(composeBinary("docker"), "docker");
    assert.equal(composeBinary("podman"), "podman");
  });

  test("parseEngineVersion reads Docker and Podman version strings", () => {
    assert.equal(parseEngineVersion("Docker version 27.3.1, build ce12230"), "27.3.1");
    assert.equal(parseEngineVersion("podman version 4.9.3\n..."), "4.9.3");
    assert.equal(parseEngineVersion("Podman version 5.2.0"), "5.2.0");
    assert.equal(parseEngineVersion(""), null);
  });

  test("podman version support gate", () => {
    assert.equal(isPodmanVersionSupported("5.2.0"), true);
    assert.equal(isPodmanVersionSupported("5.0.0"), true);
    assert.equal(isPodmanVersionSupported("4.9.3"), true);
    assert.equal(isPodmanVersionSupported("4.9.0"), true);
    assert.equal(isPodmanVersionSupported("4.8.0"), false);
    assert.equal(isPodmanVersionSupported("3.4.2"), false);
    assert.equal(isPodmanVersionSupported(null), false);
  });

  test("minimum podman version is documented", () => {
    assert.equal(minimumPodmanVersion(), "4.9.0");
  });

  test("inspectPodmanMachine parses the default machine JSON", async () => {
    const execute = async (spec) => {
      assert.equal(spec.command, "podman");
      assert.deepEqual(spec.args.slice(0, 3), ["machine", "inspect", "--format"]);
      return 0;
    };
    const machine = await inspectPodmanMachine(execute, "test-machine");
    assert.equal(machine, null);
  });

  test("listPodmanMachines returns parsed array", async () => {
    const execute = async (spec, io) => {
      assert.equal(spec.command, "podman");
      io.stdout.write(JSON.stringify([{ Name: "test", Running: true }]));
      return 0;
    };
    const machines = await listPodmanMachines(execute);
    assert.deepEqual(machines, [{ Name: "test", Running: true }]);
  });

  test("listPodmanMachines returns empty array on failure", async () => {
    const execute = async () => 1;
    const machines = await listPodmanMachines(execute);
    assert.deepEqual(machines, []);
  });

  test("podmanMachineResourceInfo extracts resources", () => {
    const info = podmanMachineResourceInfo({ CPUs: 4, Memory: 8192, DiskSize: 65536 });
    assert.equal(info.cpuCount, 4);
    assert.equal(info.memoryBytes, 8192 * 1024 ** 2);
    assert.equal(info.diskBytes, 65536 * 1024 ** 2);
  });

  test("podmanMachineResourceInfo accepts string byte sizes", () => {
    const info = podmanMachineResourceInfo({ cpus: 2, memory: "4 GiB", diskSize: "32g" });
    assert.equal(info.cpuCount, 2);
    assert.equal(info.memoryBytes, 4 * 1024 ** 3);
    assert.equal(info.diskBytes, 32 * 1024 ** 3);
  });

  test("podmanMachineResourceInfo returns null for invalid input", () => {
    assert.equal(podmanMachineResourceInfo(null), null);
    assert.equal(podmanMachineResourceInfo({}), null);
    assert.equal(podmanMachineResourceInfo({ CPUs: 0 }), null);
  });

  test("podmanMachineResizeGuidance includes machine name", () => {
    const guidance = podmanMachineResizeGuidance("dev");
    assert.match(guidance, /podman machine set dev/);
    assert.match(guidance, /podman machine start dev/);
  });
});
