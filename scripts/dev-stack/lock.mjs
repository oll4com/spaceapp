import { spawn } from "node:child_process";
import { join } from "node:path";

// Keep one inode for the checkout, even across reset. The kernel releases flock
// on EOF/process death, so recovery never races an unlink or trusts a reused PID.
const holder = `
import fcntl, os, stat, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
    raise RuntimeError("Refusing an unowned checkout lock")
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(73)
os.fchmod(fd, 0o600)
print("locked", flush=True)
sys.stdin.buffer.read()
`;

export async function acquireLock(root) {
  const child = spawn("python3", ["-c", holder, join(root, ".dev-stack.lock")], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let errorText = "", released = false;
  child.stderr.on("data", (data) => { errorText += data.toString(); });
  child.stdin.on("error", () => {});
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  try {
    await Promise.race([
      new Promise((resolve) => child.stdout.once("data", (data) => { if (data.toString().trim() === "locked") resolve(); })),
      done.then((code) => { throw Object.assign(new Error(code === 73 ? "Contributor stack is busy; stop the owning terminal or retry after shutdown." : `Cannot acquire checkout lock (Python 3 is required): ${errorText.trim()}`), { code: code === 73 ? "EBUSY" : "ELOCK" }); }),
    ]);
  } catch (error) { child.stdin.end(); throw error; }
  return {
    lost: done.then(() => { if (!released) throw new Error("Checkout lock holder exited unexpectedly."); }),
    async release() { released = true; child.stdin.end(); await done; },
  };
}
