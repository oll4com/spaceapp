export async function selectAutomaticEngine({
  execute,
  platform,
  profile,
  dockerIsReady,
  verifyPodmanPrerequisites
}) {
  let dockerReady = false;
  try {
    dockerReady = typeof execute === "function" && await dockerIsReady(execute);
  } catch {}

  let podmanReady = false;
  if (platform !== "win32" && typeof execute === "function") {
    try {
      const result = await verifyPodmanPrerequisites(execute, {
        stderr: null,
        platform,
        requestedProfile: profile
      });
      podmanReady = result?.ok === true;
    } catch {}
  }

  return !dockerReady && podmanReady ? "podman" : "docker";
}
