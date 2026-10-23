import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryCamera3D } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

// Software GL and line-width limits: WebGL2 is enough for points and lines, no rendering dependency.
const VERTEX_QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

const NODE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in float a_base;
layout(location = 2) in vec3 a_color;
layout(location = 3) in float a_state;
uniform sampler2D u_positions;
uniform vec2 u_resolution;
uniform vec2 u_posSize;
uniform float u_dpr;
uniform float u_scale;
uniform float u_zoom;
uniform float u_yawCos;
uniform float u_yawSin;
uniform float u_pitchCos;
uniform float u_pitchSin;
uniform float u_extent;
uniform float u_focusActive;
out vec2 v_uv;
out vec3 v_color;
out float v_focus;
out float v_alpha;
out float v_glow;
void main() {
  vec3 pos = texelFetch(u_positions, ivec2(gl_InstanceID % int(u_posSize.x), gl_InstanceID / int(u_posSize.x)), 0).xyz;
  float x = pos.x * u_yawCos + pos.z * u_yawSin;
  float depth = -pos.x * u_yawSin + pos.z * u_yawCos;
  float y = pos.y * u_pitchCos - depth * u_pitchSin;
  float z = pos.y * u_pitchSin + depth * u_pitchCos;
  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  float radius = max(1.0, a_base * perspective * sqrt(u_zoom)) * (a_state > 1.5 ? 1.5 : 1.0);
  float deviceX = u_resolution.x * 0.5 + (x * u_scale * u_zoom * perspective + a_corner.x * radius) * u_dpr;
  float deviceY = u_resolution.y * 0.5 - y * u_scale * u_zoom * perspective * u_dpr + a_corner.y * radius * u_dpr;
  gl_Position = vec4(deviceX / u_resolution.x * 2.0 - 1.0, 1.0 - deviceY / u_resolution.y * 2.0, clamp(z * u_scale / max(1.0, u_extent), -1.0, 1.0), 1.0);
  v_uv = a_corner * 0.5 + 0.5;
  v_color = a_color;
  v_focus = a_state > 1.5 ? 1.0 : 0.0;
  v_alpha = u_focusActive > 0.5 && a_state < 0.5 ? 0.2 : clamp(perspective, 0.4, 1.0);
  v_glow = a_base > 9.5 || a_state > 1.5 ? 1.0 : 0.0;
}`;

const NODE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_color;
in float v_focus;
in float v_alpha;
in float v_glow;
out vec4 outColor;
void main() {
  float r = length(v_uv * 2.0 - 1.0);
  float disc = 1.0 - smoothstep(0.82, 1.0, r);
  float halo = v_glow * exp(-max(0.0, r - 0.8) * 5.5);
  float alpha = v_alpha * max(disc, halo * 0.7);
  if (alpha < 0.004) discard;
  outColor = vec4(mix(v_color, vec3(1.0), v_focus * disc), alpha);
}`;

const EDGE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_endpoints;
layout(location = 2) in float a_incident;
uniform sampler2D u_positions;
uniform vec2 u_resolution;
uniform vec2 u_posSize;
uniform float u_dpr;
uniform float u_scale;
uniform float u_zoom;
uniform float u_yawCos;
uniform float u_yawSin;
uniform float u_pitchCos;
uniform float u_pitchSin;
uniform float u_extent;
uniform float u_focusActive;
out vec3 v_color;
vec2 memoryScreen(vec3 pos, out float clipZ) {
  float x = pos.x * u_yawCos + pos.z * u_yawSin;
  float depth = -pos.x * u_yawSin + pos.z * u_yawCos;
  float y = pos.y * u_pitchCos - depth * u_pitchSin;
  float z = pos.y * u_pitchSin + depth * u_pitchCos;
  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  clipZ = clamp(z * u_scale / max(1.0, u_extent), -1.0, 1.0);
  return vec2(u_resolution.x * 0.5 + x * u_scale * u_zoom * perspective * u_dpr,
    u_resolution.y * 0.5 - y * u_scale * u_zoom * perspective * u_dpr);
}
void main() {
  vec3 start = texelFetch(u_positions, ivec2(int(a_endpoints.x) % int(u_posSize.x), int(a_endpoints.x) / int(u_posSize.x)), 0).xyz;
  vec3 end = texelFetch(u_positions, ivec2(int(a_endpoints.y) % int(u_posSize.x), int(a_endpoints.y) / int(u_posSize.x)), 0).xyz;
  float clipStart, clipEnd;
  vec2 screenStart = memoryScreen(start, clipStart);
  vec2 screenEnd = memoryScreen(end, clipEnd);
  float blend = a_corner.x * 0.5 + 0.5;
  vec2 device = mix(screenStart, screenEnd, blend);
  gl_Position = vec4(device.x / u_resolution.x * 2.0 - 1.0, 1.0 - device.y / u_resolution.y * 2.0, mix(clipStart, clipEnd, blend), 1.0);
  v_color = a_incident > 0.5 ? vec3(0.596, 0.855, 0.98)
    : u_focusActive > 0.5 ? vec3(0.078, 0.125, 0.169)
    : mix(vec3(0.125, 0.2, 0.263), vec3(0.219, 0.313, 0.408), a_endpoints.z);
}`;

const EDGE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;

const colorCache = new Map<string, [number, number, number]>();
const parseColor = (color: string): [number, number, number] => {
  const cached = colorCache.get(color);
  if (cached) return cached;
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color : "#7395ad";
  const parsed = [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16) / 255) as [number, number, number];
  colorCache.set(color, parsed);
  return parsed;
};

export type Memory3DWebGLRenderer = {
  /** Uploads the static geometry: node order, colors, edge endpoints, focus adjacency. */
  upload(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>): void;
  /** Uploads the packed position texture; called again whenever streamed layout coordinates change. */
  positions(packed: Float32Array, posWidth: number, posHeight: number): void;
  /** Recomputes focus/neighbor dimming and incident edge flags; O(nodes + edges), only on focus change. */
  updateFocus(focus: string | null): void;
  /** Uniform-only frame: no per-frame CPU projection or depth sort. */
  render(camera: MemoryCamera3D, width: number, height: number, dpr: number, scale: number, extent: number, focus: string | null): void;
  destroy(): void;
};

export function createMemory3DWebGLRenderer(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): Memory3DWebGLRenderer | null {
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
      return shader;
    };
    const program = (vertexSource: string, fragmentSource: string) => {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
      return program;
    };
    const nodeProgram = program(NODE_VERTEX, NODE_FRAGMENT);
    const edgeProgram = program(EDGE_VERTEX, EDGE_FRAGMENT);
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, VERTEX_QUAD, gl.STATIC_DRAW);
    const positionsTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, positionsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const nodeInstances = gl.createBuffer(), nodeStates = gl.createBuffer(), edgeInstances = gl.createBuffer(), edgeIncidents = gl.createBuffer();
    let nodeCount = 0, edgeCount = 0, posWidth = 1, posHeight = 1;
    let indexById = new Map<string, number>(), adjacency = new Map<string, string[]>(), orderedEdges: MemoryGraphEdge[] = [];
    const setVertexPointers = (nodeMode: boolean) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      if (nodeMode) {
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeInstances);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 16, 4);
        gl.vertexAttribDivisor(2, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeStates);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 4, 0);
        gl.vertexAttribDivisor(3, 1);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeInstances);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeIncidents);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 4, 0);
        gl.vertexAttribDivisor(2, 1);
        gl.disableVertexAttribArray(3);
      }
    };
    const upload: Memory3DWebGLRenderer["upload"] = (nodes, edges, positions) => {
      indexById = new Map(nodes.map((node, index) => [node.id, index]));
      orderedEdges = edges.filter(edge => indexById.has(edge.source) && indexById.has(edge.target));
      adjacency = new Map();
      for (const edge of edges) {
        if (!indexById.has(edge.source) || !indexById.has(edge.target)) continue;
        const forward = adjacency.get(edge.source);
        if (forward) forward.push(edge.target); else adjacency.set(edge.source, [edge.target]);
        const back = adjacency.get(edge.target);
        if (back) back.push(edge.source); else adjacency.set(edge.target, [edge.source]);
      }
      nodeCount = nodes.length;
      edgeCount = orderedEdges.length;
      const instances = new Float32Array(nodeCount * 4);
      for (let index = 0; index < nodeCount; index++) {
        const node = nodes[index]!;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        instances[index * 4] = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
        const color = positions.get(node.id)?.color ?? "#7395ad";
        const [r, g, b] = parseColor(color);
        instances[index * 4 + 1] = r; instances[index * 4 + 2] = g; instances[index * 4 + 3] = b;
      }
      const edgeData = new Float32Array(edgeCount * 3);
      orderedEdges.forEach((edge, slot) => {
        edgeData[slot * 3] = indexById.get(edge.source)!; edgeData[slot * 3 + 1] = indexById.get(edge.target)!;
        edgeData[slot * 3 + 2] = edge.type === "DERIVED_FROM" ? 1 : 0;
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, nodeInstances);
      gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, nodeStates);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nodeCount), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeInstances);
      gl.bufferData(gl.ARRAY_BUFFER, edgeData, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeIncidents);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeCount), gl.DYNAMIC_DRAW);
    };
    const positions: Memory3DWebGLRenderer["positions"] = (packed, width, height) => {
      posWidth = width; posHeight = height;
      // RGBA32F texels are four floats each while the stream carries xyz triples,
      // so repack in order: texel i := (x, y, z, 0) for node i, remaining alpha = 0.
      const texels = new Float32Array(width * height * 4);
      for (let i = 0, n = Math.min(packed.length / 3, width * height); i < n; i++) {
        texels[i * 4] = packed[i * 3]!; texels[i * 4 + 1] = packed[i * 3 + 1]!; texels[i * 4 + 2] = packed[i * 3 + 2]!;
      }
      gl.bindTexture(gl.TEXTURE_2D, positionsTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, posWidth, posHeight, 0, gl.RGBA, gl.FLOAT, texels);
    };
    const updateFocus: Memory3DWebGLRenderer["updateFocus"] = focus => {
      const states = new Float32Array(nodeCount);
      if (focus) {
        const focusIndex = indexById.get(focus);
        if (focusIndex !== undefined) {
          states[focusIndex] = 2;
          for (const neighbor of adjacency.get(focus) ?? []) {
            const index = indexById.get(neighbor);
            if (index !== undefined && index !== focusIndex) states[index] = 1;
          }
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, nodeStates);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, states);
      const incidents = new Float32Array(edgeCount);
      if (focus) {
        orderedEdges.forEach((edge, slot) => {
          if (edge.source === focus || edge.target === focus) incidents[slot] = 1;
        });
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeIncidents);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, incidents);
    };
    const uniforms = (program: WebGLProgram, camera: MemoryCamera3D, width: number, height: number, dpr: number, scale: number, extent: number, focusActive: number) => {
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), width * dpr, height * dpr);
      gl.uniform2f(gl.getUniformLocation(program, "u_posSize"), posWidth, posHeight);
      gl.uniform1f(gl.getUniformLocation(program, "u_dpr"), dpr);
      gl.uniform1f(gl.getUniformLocation(program, "u_scale"), scale);
      gl.uniform1f(gl.getUniformLocation(program, "u_zoom"), camera.zoom);
      gl.uniform1f(gl.getUniformLocation(program, "u_yawCos"), Math.cos(camera.yaw));
      gl.uniform1f(gl.getUniformLocation(program, "u_yawSin"), Math.sin(camera.yaw));
      gl.uniform1f(gl.getUniformLocation(program, "u_pitchCos"), Math.cos(camera.pitch));
      gl.uniform1f(gl.getUniformLocation(program, "u_pitchSin"), Math.sin(camera.pitch));
      gl.uniform1f(gl.getUniformLocation(program, "u_extent"), extent);
      gl.uniform1f(gl.getUniformLocation(program, "u_focusActive"), focusActive);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, positionsTexture);
      gl.uniform1i(gl.getUniformLocation(program, "u_positions"), 0);
    };
    const render: Memory3DWebGLRenderer["render"] = (camera, width, height, dpr, scale, extent, focus) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const focusActive = focus ? 1 : 0;
      uniforms(edgeProgram, camera, width, height, dpr, scale, extent, focusActive);
      setVertexPointers(false);
      gl.depthMask(false);
      gl.drawArraysInstanced(gl.LINES, 0, 2, edgeCount);
      uniforms(nodeProgram, camera, width, height, dpr, scale, extent, focusActive);
      setVertexPointers(true);
      gl.depthMask(true);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
      gl.depthMask(false);
    };
    return {
      upload, positions, updateFocus, render,
      destroy: () => {
        gl.deleteProgram(nodeProgram); gl.deleteProgram(edgeProgram);
        gl.deleteBuffer(quadBuffer); gl.deleteBuffer(nodeInstances); gl.deleteBuffer(nodeStates);
        gl.deleteBuffer(edgeInstances); gl.deleteBuffer(edgeIncidents); gl.deleteTexture(positionsTexture);
      }
    };
  } catch {
    return null;
  }
}
