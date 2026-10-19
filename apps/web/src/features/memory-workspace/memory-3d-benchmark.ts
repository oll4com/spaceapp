import type { MemoryCamera3D } from "./memory-3d.js";
import type { MemoryWebGLRenderer } from "./memory-3d-webgl.js";

export interface MemoryGraphBenchmark {
  nodes: number; edges: number; renderer: string; userAgent: string;
  viewport: [number, number]; dpr: number; devicePixelRatio: number; labelPixelRatio: number; visibility: DocumentVisibilityState;
  samples: number; frameP95Ms: number; frameMedianMs: number; frameMaxMs: number;
  drawCpuP95Ms: number; pickingP95Ms: number; pickingMaxMs: number;
  loadLongTasksMs: number[]; benchmarkLongTasksMs: number[]; generatedAt: string;
}

const percentile = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;

/** In-browser wall-clock rAF intervals and indexed picking; never a Node CPU proxy. */
export class MemoryBenchmarkSession {
  private last = 0;
  private warmup = 60;
  private frames: number[] = [];
  private picks: number[] = [];
  private frame = 0;
  private drawStarted = 0;
  private drawCpu: number[] = [];
  readonly startedAt = performance.now();

  constructor(private readonly input: Pick<MemoryGraphBenchmark, "nodes" | "edges" | "renderer" | "viewport" | "dpr" | "devicePixelRatio" | "labelPixelRatio" | "loadLongTasksMs">, private readonly finish: (result: MemoryGraphBenchmark) => void, private readonly progress?: (frames: number) => void) {}

  beforeDraw(timestamp: number, camera: MemoryCamera3D) {
    this.drawStarted = performance.now();
    camera.yaw += 0.012; camera.zoom = 1 + 0.25 * Math.sin(this.frame++ / 45);
    if (this.warmup > 0) this.warmup--;
    else if (this.last) this.frames.push(timestamp - this.last);
    this.last = timestamp;
    if (this.frame % 60 === 0) this.progress?.(this.frames.length);
  }
  afterDraw(renderer: MemoryWebGLRenderer, width: number, height: number, longTasks: Array<{ start: number; duration: number }>): boolean {
    if (this.warmup === 0) this.drawCpu.push(performance.now() - this.drawStarted);
    const started = performance.now(); renderer.pick(width / 2, height / 2);
    if (this.warmup === 0) this.picks.push(performance.now() - started);
    if (this.frames.length < 300) return false;
    this.finish({ ...this.input, samples: this.frames.length, frameP95Ms: percentile(this.frames),
      frameMedianMs: [...this.frames].sort((a, b) => a - b)[Math.floor(this.frames.length / 2)] ?? 0,
      frameMaxMs: Math.max(0, ...this.frames), drawCpuP95Ms: percentile(this.drawCpu), pickingP95Ms: percentile(this.picks), pickingMaxMs: Math.max(0, ...this.picks),
      benchmarkLongTasksMs: longTasks.filter(task => task.start >= this.startedAt).map(task => task.duration),
      userAgent: navigator.userAgent, visibility: document.visibilityState, generatedAt: new Date().toISOString() });
    return true;
  }
}
