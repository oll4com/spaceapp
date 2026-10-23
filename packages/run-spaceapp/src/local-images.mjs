const SUPPORTED_ENGINES = new Set(["docker", "podman"]);

export function createLocalImagesExecutor(execute, stdout) {
  return async (spec, io) => {
    if (SUPPORTED_ENGINES.has(spec.command) && spec.args?.includes("compose")) {
      if (spec.args.at(-1) === "pull") {
        stdout.write("Local images only: skipping registry downloads; missing images will fail startup.\n");
        return 0;
      }
      const upIndex = spec.args.indexOf("up");
      if (upIndex !== -1) {
        spec = {
          ...spec,
          args: [...spec.args.slice(0, upIndex + 1), "--pull", "never", ...spec.args.slice(upIndex + 1)]
        };
      }
    }
    return execute(spec, io);
  };
}
