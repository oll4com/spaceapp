/**
 * WebGL2 renderer for the 3D memory graph (issue #62).
 *
 * Versus the previous Canvas 2D renderer: rotation/zoom are shader uniforms
 * (per-frame CPU work is O(1), not O(nodes)); depth moves to the GPU depth
 * buffer (no CPU sort); points draw as sprites, edges as one line buffer;
 * hit testing uses a rebuilt-on-demand spatial hash; labels stay on a 2D
 * overlay with LOD; `isSupported()` gates the Canvas 2D fallback.
 */

export interface WebGLGraphPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  color: number;
  alpha: number;
}

export interface WebGLGraphEdge {
  a: number;
  b: number;
  color: number;
  alpha: number;
}

export interface WebGLGraphCamera {
  yaw: number;
  pitch: number;
  zoom: number;
}

const VERTEX_POINT_SHADER = `#version 300 es
uniform vec2 uViewport;
uniform vec2 uCamera;
uniform float uZoom;
uniform float uBaseScale;
in vec3 aPosition;
in vec4 aColor;
in float aRadius;
out vec4 vColor;
out float vPointRadius;

void main() {
  float cx = cos(uCamera.x), sx = sin(uCamera.x);
  vec3 rotated = vec3(
    aPosition.x * cx + aPosition.z * sx,
    aPosition.y,
    -aPosition.x * sx + aPosition.z * cx
  );
  float cy = cos(uCamera.y), sy = sin(uCamera.y);
  vec3 view = vec3(
    rotated.x,
    rotated.y * cy - rotated.z * sy,
    rotated.y * sy + rotated.z * cy
  );
  float perspective = 650.0 / max(120.0, 650.0 + view.z * uBaseScale * uZoom);
  float halfW = uViewport.x * 0.5;
  float halfH = uViewport.y * 0.5;
  gl_Position = vec4(
    view.x * uBaseScale * uZoom * perspective / halfW,
    view.y * uBaseScale * uZoom * perspective / halfH,
    clamp(view.z * uBaseScale * uZoom / 650.0, -1.0, 1.0),
    1.0
  );
  float size = aRadius * uBaseScale * uZoom * perspective;
  gl_PointSize = clamp(size, 1.0, 64.0);
  vColor = vec4(aColor.rgb, aColor.a * clamp(perspective, 0.4, 1.0));
  vPointRadius = size;
}`;

const VERTEX_LINE_SHADER = `#version 300 es
uniform vec2 uViewport;
uniform vec2 uCamera;
uniform float uZoom;
uniform float uBaseScale;
in vec3 aPosition;
in vec4 aColor;
out vec4 vColor;

void main() {
  float cx = cos(uCamera.x), sx = sin(uCamera.x);
  vec3 rotated = vec3(
    aPosition.x * cx + aPosition.z * sx,
    aPosition.y,
    -aPosition.x * sx + aPosition.z * cx
  );
  float cy = cos(uCamera.y), sy = sin(uCamera.y);
  vec3 view = vec3(
    rotated.x,
    rotated.y * cy - rotated.z * sy,
    rotated.y * sy + rotated.z * cy
  );
  float perspective = 650.0 / max(120.0, 650.0 + view.z * uBaseScale * uZoom);
  float halfW = uViewport.x * 0.5;
  float halfH = uViewport.y * 0.5;
  gl_Position = vec4(
    view.x * uBaseScale * uZoom * perspective / halfW,
    view.y * uBaseScale * uZoom * perspective / halfH,
    clamp(view.z * uBaseScale * uZoom / 650.0, -1.0, 1.0),
    1.0
  );
  vColor = vec4(aColor.rgb, aColor.a * clamp(perspective, 0.35, 1.0));
}`;

const FRAGMENT_POINT_SHADER = `#version 300 es
precision mediump float;
in vec4 vColor;
in float vPointRadius;
out vec4 fragColor;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float radius2 = dot(uv, uv);
  if (radius2 > 1.0) discard;
  float edge = smoothstep(1.0, 0.82, radius2);
  fragColor = vec4(vColor.rgb, vColor.a * edge);
}`;

const FRAGMENT_LINE_SHADER = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${info}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vertex);
  const f = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${info}`);
  }
  return program;
}

export function isWebGL2Supported(): boolean {
  try {
    // Probe on a throwaway canvas: probing the render canvas would leave a
    // (lost) WebGL2 context attached to it — the renderer would then receive
    // that lost context, and the 2D fallback could never get a 2D context
    // from the same canvas (issue #62 review fix).
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2", { antialias: true });
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Pure helper: model position -> normalized aPosition (unit-testable). */
export function normalizePosition(
  point: { x: number; y: number; z: number },
  extent: number
): [number, number, number] {
  const scale = Math.max(1e-6, extent);
  return [point.x / scale, point.y / scale, point.z / scale];
}

/** Pure helper: pixels-per-model-unit for a viewport, mirroring the 2D renderer. */
export function baseScaleFor(viewportMinSide: number, extent: number): number {
  return (viewportMinSide * 0.4) / Math.max(60, extent);
}

/** Pure helper: LOD decision for labels, mirroring the 2D renderer rules. */
export function shouldShowLabel(
  nodeType: string,
  isFocus: boolean,
  isCore: boolean,
  zoom: number
): boolean {
  return nodeType === "SOURCE" || isFocus || isCore || zoom >= 1.6;
}

function unpackColor(color: number): [number, number, number] {
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}

export class MemoryGraphWebGLRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly pointProgram: WebGLProgram;
  private readonly lineProgram: WebGLProgram;
  private readonly pointPosition: WebGLBuffer;
  private readonly pointColor: WebGLBuffer;
  private readonly pointRadius: WebGLBuffer;
  private readonly linePosition: WebGLBuffer;
  private readonly lineColor: WebGLBuffer;
  private pointCount = 0;
  private lineCount = 0;
  private baseScale = 1;
  private viewport: { width: number; height: number; dpr: number } = { width: 1, height: 1, dpr: 1 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, depth: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.pointProgram = link(gl, VERTEX_POINT_SHADER, FRAGMENT_POINT_SHADER);
    this.lineProgram = link(gl, VERTEX_LINE_SHADER, FRAGMENT_LINE_SHADER);
    this.pointPosition = gl.createBuffer()!;
    this.pointColor = gl.createBuffer()!;
    this.pointRadius = gl.createBuffer()!;
    this.linePosition = gl.createBuffer()!;
    this.lineColor = gl.createBuffer()!;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
  }

  /** Uploads the geometry in raw model units; extent normalization happens
   * through `baseScaleFor` in the projection, so there is exactly one
   * division by the extent end-to-end (issue #62 review fix). */
  setGeometry(points: WebGLGraphPoint[], edges: WebGLGraphEdge[]): void {
    const gl = this.gl;
    this.pointCount = points.length;
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 4);
    const radii = new Float32Array(points.length);
    points.forEach((point, index) => {
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      const [r, g, b] = unpackColor(point.color);
      colors[index * 4] = r;
      colors[index * 4 + 1] = g;
      colors[index * 4 + 2] = b;
      colors[index * 4 + 3] = point.alpha;
      radii[index] = point.radius;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointPosition);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointColor);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointRadius);
    gl.bufferData(gl.ARRAY_BUFFER, radii, gl.STATIC_DRAW);

    this.lineCount = edges.length * 2;
    const linePositions = new Float32Array(edges.length * 6);
    const lineColors = new Float32Array(edges.length * 8);
    edges.forEach((edge, index) => {
      const a = points[edge.a], b = points[edge.b];
      const offset = index * 6;
      if (a && b) {
        linePositions[offset] = a.x;
        linePositions[offset + 1] = a.y;
        linePositions[offset + 2] = a.z;
        linePositions[offset + 3] = b.x;
        linePositions[offset + 4] = b.y;
        linePositions[offset + 5] = b.z;
      }
      const [r, g, bl] = unpackColor(edge.color);
      const colorOffset = index * 8;
      for (let corner = 0; corner < 2; corner++) {
        lineColors[colorOffset + corner * 4] = r;
        lineColors[colorOffset + corner * 4 + 1] = g;
        lineColors[colorOffset + corner * 4 + 2] = bl;
        lineColors[colorOffset + corner * 4 + 3] = edge.alpha;
      }
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linePosition);
    gl.bufferData(gl.ARRAY_BUFFER, linePositions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColor);
    gl.bufferData(gl.ARRAY_BUFFER, lineColors, gl.STATIC_DRAW);
  }

/** Re-uploads only per-node colors (focus dimming / highlight). */
  updateNodeColors(colors: Float32Array): void {
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.pointColor);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.DYNAMIC_DRAW);
  }

  /** Re-uploads only per-edge colors (incident-edge highlight). */
  updateEdgeColors(colors: Float32Array): void {
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.lineColor);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.DYNAMIC_DRAW);
  }

  resize(width: number, height: number, dpr: number, extent: number): void {
    this.viewport = { width, height, dpr };
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.baseScale = baseScaleFor(Math.min(width, height), extent);
  }

  /** One draw pass. Camera values match the 2D renderer's camera semantics. */
  render(camera: WebGLGraphCamera): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.lineCount > 0) {
      gl.useProgram(this.lineProgram);
      gl.uniform2f(gl.getUniformLocation(this.lineProgram, "uViewport"), this.viewport.width, this.viewport.height);
      gl.uniform2f(gl.getUniformLocation(this.lineProgram, "uCamera"), camera.yaw, camera.pitch);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, "uZoom"), camera.zoom);
      gl.uniform1f(gl.getUniformLocation(this.lineProgram, "uBaseScale"), this.baseScale);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.linePosition);
      const linePosition = gl.getAttribLocation(this.lineProgram, "aPosition");
      gl.enableVertexAttribArray(linePosition);
      gl.vertexAttribPointer(linePosition, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColor);
      const lineColor = gl.getAttribLocation(this.lineProgram, "aColor");
      gl.enableVertexAttribArray(lineColor);
      gl.vertexAttribPointer(lineColor, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
    }
    if (this.pointCount > 0) {
      gl.useProgram(this.pointProgram);
      gl.uniform2f(gl.getUniformLocation(this.pointProgram, "uViewport"), this.viewport.width, this.viewport.height);
      gl.uniform2f(gl.getUniformLocation(this.pointProgram, "uCamera"), camera.yaw, camera.pitch);
      gl.uniform1f(gl.getUniformLocation(this.pointProgram, "uZoom"), camera.zoom);
      gl.uniform1f(gl.getUniformLocation(this.pointProgram, "uBaseScale"), this.baseScale);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointPosition);
      const pointPosition = gl.getAttribLocation(this.pointProgram, "aPosition");
      gl.enableVertexAttribArray(pointPosition);
      gl.vertexAttribPointer(pointPosition, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointColor);
      const pointColor = gl.getAttribLocation(this.pointProgram, "aColor");
      gl.enableVertexAttribArray(pointColor);
      gl.vertexAttribPointer(pointColor, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointRadius);
      const pointRadius = gl.getAttribLocation(this.pointProgram, "aRadius");
      gl.enableVertexAttribArray(pointRadius);
      gl.vertexAttribPointer(pointRadius, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.pointCount);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const buffer of [this.pointPosition, this.pointColor, this.pointRadius, this.linePosition, this.lineColor]) {
      gl.deleteBuffer(buffer);
    }
    gl.deleteProgram(this.pointProgram);
    gl.deleteProgram(this.lineProgram);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}