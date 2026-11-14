import { request } from "node:http";

// The Firecracker API calls a cell's lifecycle needs, over the VM's API unix socket (Firecracker v1.17, the calls
// K3's fc-vm.sh makes with curl --unix-socket). Paths are relative to the jailer chroot, as Firecracker sees them.

/** Technical bound: a Firecracker that stops answering must not hold a wake or a sleep forever; a 2 GiB Full snapshot to NVMe took seconds in K3. */
export const FIRECRACKER_REQUEST_TIMEOUT_MS = 60_000;

export class FirecrackerApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly faultMessage: string
  ) {
    super(`Firecracker ${method} ${path} answered ${status}: ${faultMessage}`);
  }
}

export interface FirecrackerClient {
  pause(): Promise<void>;
  resume(): Promise<void>;
  createSnapshot(paths: { snapshotPath: string; memFilePath: string }): Promise<void>;
  /** A tampered or foreign snapshot answers 400 (K3), which rejects with FirecrackerApiError. */
  loadSnapshot(paths: { snapshotPath: string; memFilePath: string }, resumeVm: boolean): Promise<void>;
  setBalloon(amountMib: number): Promise<void>;
}

export function createFirecrackerClient(socketPath: string, timeoutMs = FIRECRACKER_REQUEST_TIMEOUT_MS): FirecrackerClient {
  function call(method: "PUT" | "PATCH", path: string, body: unknown): Promise<void> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method,
          path,
          timeout: timeoutMs,
          headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(payload) }
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve();
            let fault = text;
            try {
              fault = (JSON.parse(text) as { fault_message?: string }).fault_message ?? text;
            } catch {
              // not JSON: keep the raw text
            }
            reject(new FirecrackerApiError(method, path, status, fault));
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error(`Firecracker ${method} ${path} timed out after ${timeoutMs} ms`)));
      req.on("error", reject);
      req.end(payload);
    });
  }
  return {
    pause: () => call("PATCH", "/vm", { state: "Paused" }),
    resume: () => call("PATCH", "/vm", { state: "Resumed" }),
    createSnapshot: ({ snapshotPath, memFilePath }) =>
      call("PUT", "/snapshot/create", { snapshot_type: "Full", snapshot_path: snapshotPath, mem_file_path: memFilePath }),
    loadSnapshot: ({ snapshotPath, memFilePath }, resumeVm) =>
      call("PUT", "/snapshot/load", {
        snapshot_path: snapshotPath,
        mem_backend: { backend_type: "File", backend_path: memFilePath },
        resume_vm: resumeVm
      }),
    setBalloon: (amountMib) => call("PATCH", "/balloon", { amount_mib: amountMib })
  };
}
