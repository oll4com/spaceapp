// Deliberately simulated provider for contributor smoke checks. No AI,
// network, account data, files, tools, or shell commands are evaluated here.
let pending = "";
let executionCount = 0;
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("OFFLINE_READY\n");
process.stdin.on("data", chunk => {
  pending += chunk.toString("utf8");
  if (pending.includes("\u0003")) {
    pending = "";
    process.stdout.write("OFFLINE_CANCELLED\n");
    return;
  }
  if (pending.length > 4096) process.exit(2);
  let boundary;
  while ((boundary = pending.search(/[\r\n]/)) >= 0) {
    const line = pending.slice(0, boundary);
    pending = pending.slice(boundary + 1);
    if (!line) continue;
    try {
      const request = JSON.parse(line);
      if (typeof request.id !== "string" || !Array.isArray(request.numbers) ||
          request.numbers.length > 16 || !request.numbers.every(Number.isSafeInteger)) throw new Error();
      const total = request.numbers.reduce((sum, value) => sum + value, 0);
      if (!Number.isSafeInteger(total)) throw new Error();
      executionCount += 1;
      process.stdout.write(`OFFLINE_RESULT:${JSON.stringify({ id: request.id, total, executionCount })}\n`);
    } catch {
      process.stdout.write("OFFLINE_ERROR:INVALID_TASK\n");
    }
  }
});
