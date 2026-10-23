export function rootlessStatus(info) {
  const explicit = info?.host?.security?.rootless;
  if (typeof explicit === "boolean") return explicit;

  const options = info?.SecurityOptions;
  if (!Array.isArray(options)) return null;
  return options.some((option) =>
    typeof option === "string" && option.toLowerCase().includes("name=rootless")
  );
}
