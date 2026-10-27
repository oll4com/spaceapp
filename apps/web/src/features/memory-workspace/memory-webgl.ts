import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryPickIndex } from "./memory-3d-picking.js";

export function supportsMemoryWebGL2() {
  if (typeof document === "undefined") return false;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
const projection = `
uniform vec4 camera; // yaw,pitch,zoom,scale
uniform vec2 viewport;
uniform float extent;
vec3 project(vec3 p) {
 float x=p.x*cos(camera.x)+p.z*sin(camera.x), d=-p.x*sin(camera.x)+p.z*cos(camera.x);
 float y=p.y*cos(camera.y)-d*sin(camera.y), z=p.y*sin(camera.y)+d*cos(camera.y);
 float perspective=650.0/max(120.0,650.0+z*camera.w);
 return vec3(x*camera.w*camera.z*perspective,y*camera.w*camera.z*perspective,z);
}
vec4 clip(vec3 p) { return vec4(p.xy*2.0/viewport, p.z/(extent*2.0),1.0); }
`;
const nodeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 color;
layout(location=2) in float radius;
layout(location=3) in float emphasis;
uniform bool focused;
${projection}
out vec2 uv;
out vec4 tint;
void main(){
 vec2 corners[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
 uv=corners[gl_VertexID];
 vec3 p=project(position);
 float perspective=650.0/max(120.0,650.0+p.z*camera.w);
 float r=max(1.0,radius*perspective*sqrt(camera.z))*(emphasis>1.5?1.5:1.0);
 p.xy+=uv*r;
 gl_Position=clip(p);
 tint=vec4(emphasis>1.5?vec3(1):color,focused&&emphasis<0.5?0.2:clamp(perspective,0.4,1.0));
}`;
const nodeFragment = `#version 300 es
precision highp float;
in vec2 uv;in vec4 tint;
out vec4 outputColor;
void main(){float distance=length(uv);if(distance>1.0)discard;
 float a=1.0-smoothstep(1.0-fwidth(distance),1.0,distance); outputColor=vec4(tint.rgb,tint.a*a);
}`;
const edgeVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in float kind;
layout(location=2) in float incident;
uniform bool focused;
${projection}
out vec3 tint;
void main(){gl_Position=clip(project(position));tint=incident>0.5?vec3(.596,.855,.98):focused?vec3(.078,.125,.169):kind>0.5?vec3(.22,.314,.408):vec3(.125,.20,.263);}`;
const edgeFragment = `#version 300 es
precision highp float;in vec3 tint;out vec4 outputColor;void main(){outputColor=vec4(tint,1);}`;

/** Instanced nodes, batched edges and a layout-only BVH. Camera changes upload uniforms only. */
export class MemoryWebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs: WebGLProgram[] = [];
  private buffers: WebGLBuffer[] = [];
  private vaos: WebGLVertexArrayObject[] = [];
  private width = 1;
  private height = 1;
  private nodes: MemoryGraphNode[] = [];
  private edges: MemoryGraphEdge[] = [];
  private flags = new Float32Array();
  private edgeFlags = new Float32Array();
  private ids = new Map<string, number>();
  private neighbors = new Map<string, Set<string>>();
  private focus: string | null = null;
  private edgeCount = 0;
  private picker: MemoryPickIndex | null = null;
  private camera: MemoryCamera3D = { yaw: 0, pitch: 0, zoom: 1 };
  extent = 60;
  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const program = (vertex: string, fragment: string) => {
      const p = gl.createProgram()!;
      for (const [type, code] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, code);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const message = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          gl.deleteProgram(p);
          throw new Error(message ?? "Shader failed");
        }
        gl.attachShader(p, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p) ?? "Program failed");
      this.programs.push(p);
      return p;
    };
    try {
      program(nodeVertex, nodeFragment);
      program(edgeVertex, edgeFragment);
      for (let i = 0; i < 2; i++) this.vaos.push(gl.createVertexArray()!);
      for (let i = 0; i < 7; i++) this.buffers.push(gl.createBuffer()!);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  private attribute(
    vao: number,
    slot: number,
    buffer: number,
    size: number,
    data: Float32Array,
    instanced: boolean,
  ) {
    const gl = this.gl;
    gl.bindVertexArray(this.vaos[vao]!);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[buffer]!);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(slot);
    gl.vertexAttribPointer(slot, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(slot, instanced ? 1 : 0);
  }
  private generation = 0;
  /** Prepare a complete replacement in short tasks, keeping the previous scene interactive. */
  async setScene(
    nodes: MemoryGraphNode[],
    edges: MemoryGraphEdge[],
    coordinates: Map<string, MemoryPoint3D>,
    colors: Map<string, MemoryAtlasPosition>,
  ) {
    const generation = ++this.generation;
    const yieldTask = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0));
    const visibleNodes = nodes.filter((n) => coordinates.has(n.id));
    const ids = new Map(visibleNodes.map((n, i) => [n.id, i]));
    const visibleEdges = edges.filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    );
    await yieldTask();
    const xyz = new Float32Array(visibleNodes.length * 3),
      rgb = new Float32Array(xyz.length),
      radii = new Float32Array(visibleNodes.length);
    let extent = 60;
    for (let i = 0; i < visibleNodes.length; i++) {
      const n = visibleNodes[i]!,
        p = coordinates.get(n.id)!;
      xyz.set([p.x, p.y, p.z], i * 3);
      extent = Math.max(extent, Math.hypot(p.x, p.y, p.z));
      const color = Number.parseInt(
        (colors.get(n.id)?.color ?? "#7395ad").slice(1),
        16,
      );
      rgb.set(
        [
          (color >>> 16) / 255,
          ((color >>> 8) & 255) / 255,
          (color & 255) / 255,
        ],
        i * 3,
      );
      radii[i] =
        n.type === "SOURCE" ? (isMemoryCoreLabel(n.label) ? 10 : 4.6) : 2.1;
      if (i % 5000 === 4999) {
        await yieldTask();
        if (generation !== this.generation) return false;
      }
    }
    const edgeCount = visibleEdges.length * 2,
      endpoints = new Float32Array(edgeCount * 3),
      kinds = new Float32Array(edgeCount);
    const neighbors = new Map<string, Set<string>>();
    for (let i = 0; i < visibleEdges.length; i++) {
      const e = visibleEdges[i]!,
        a = ids.get(e.source)!,
        b = ids.get(e.target)!;
      endpoints.set(xyz.subarray(a * 3, a * 3 + 3), i * 6);
      endpoints.set(xyz.subarray(b * 3, b * 3 + 3), i * 6 + 3);
      kinds[i * 2] = kinds[i * 2 + 1] = e.type === "DERIVED_FROM" ? 1 : 0;
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
      neighbors.get(e.source)!.add(e.target);
      neighbors.get(e.target)!.add(e.source);
      if (i % 10000 === 9999) {
        await yieldTask();
        if (generation !== this.generation) return false;
      }
    }
    const picker = new MemoryPickIndex(xyz, radii);
    await yieldTask();
    if (generation !== this.generation || this.gl.isContextLost()) return false;
    this.nodes = visibleNodes;
    this.edges = visibleEdges;
    this.ids = ids;
    this.neighbors = neighbors;
    this.extent = extent;
    this.edgeCount = edgeCount;
    this.picker = picker;
    this.flags = new Float32Array(visibleNodes.length);
    this.edgeFlags = new Float32Array(edgeCount);
    this.attribute(0, 0, 0, 3, xyz, true);
    this.attribute(0, 1, 1, 3, rgb, true);
    this.attribute(0, 2, 2, 1, radii, true);
    this.attribute(0, 3, 3, 1, this.flags, true);
    this.attribute(1, 0, 4, 3, endpoints, false);
    this.attribute(1, 1, 5, 1, kinds, false);
    this.attribute(1, 2, 6, 1, this.edgeFlags, false);
    const focus = this.focus;
    this.focus = null;
    this.setFocus(focus);
    return true;
  }
  setFocus(focus: string | null) {
    if (this.focus === focus) return;
    this.focus = focus;
    this.flags.fill(0);
    this.edgeFlags.fill(0);
    if (focus) {
      for (const id of this.neighbors.get(focus) ?? []) {
        const i = this.ids.get(id);
        if (i !== undefined) this.flags[i] = 1;
      }
      const i = this.ids.get(focus);
      if (i !== undefined) this.flags[i] = 2;
      this.edges.forEach((e, i) => {
        if (e.source === focus || e.target === focus)
          this.edgeFlags[i * 2] = this.edgeFlags[i * 2 + 1] = 1;
      });
    }
    this.attribute(0, 3, 3, 1, this.flags, true);
    this.attribute(1, 2, 6, 1, this.edgeFlags, false);
  }
  resize(width: number, height: number, dpr: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.gl.canvas.width = Math.max(1, Math.round(width * dpr));
    this.gl.canvas.height = Math.max(1, Math.round(height * dpr));
  }
  draw(camera: MemoryCamera3D) {
    this.camera = { ...camera };
    const gl = this.gl,
      scale = (Math.min(this.width, this.height) * 0.4) / this.extent;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.DITHER);
    const bindProgram = (index: number) => {
      const p = this.programs[index]!;
      gl.useProgram(p);
      gl.bindVertexArray(this.vaos[index]!);
      gl.uniform4f(
        gl.getUniformLocation(p, "camera"),
        camera.yaw,
        camera.pitch,
        camera.zoom,
        scale,
      );
      gl.uniform2f(
        gl.getUniformLocation(p, "viewport"),
        this.width,
        this.height,
      );
      gl.uniform1f(gl.getUniformLocation(p, "extent"), this.extent);
      gl.uniform1i(gl.getUniformLocation(p, "focused"), this.focus ? 1 : 0);
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    bindProgram(1);
    gl.drawArrays(gl.LINES, 0, this.edgeCount);
    bindProgram(0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodes.length);
    return scale;
  }
  pick(x: number, y: number, camera = this.camera) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const scale = (Math.min(this.width, this.height) * 0.4) / this.extent;
    return (
      this.nodes[
        this.picker?.pick(
          x,
          y,
          camera,
          scale,
          this.width,
          this.height,
          this.extent,
          this.focus ? (this.ids.get(this.focus) ?? -1) : -1,
        ) ?? -1
      ]?.id ?? null
    );
  }
  destroy() {
    this.generation++;
    const gl = this.gl;
    for (const p of this.programs) gl.deleteProgram(p);
    for (const b of this.buffers) gl.deleteBuffer(b);
    for (const v of this.vaos) gl.deleteVertexArray(v);
  }
}
