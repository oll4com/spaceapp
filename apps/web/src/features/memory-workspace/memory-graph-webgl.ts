import type { MemoryCamera3D } from "./memory-3d.js";

const NODE_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color;
in float a_radius;
in vec3 a_pickingId;

uniform vec3 u_camera; // yaw, pitch, zoom
uniform vec2 u_viewport; // width, height
uniform float u_scale;
uniform float u_dpr;
uniform float u_picking; // 0.0: draw, 1.0: picking

out vec4 v_color;
out vec3 v_pickingId;

void main() {
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float zoom = u_camera.z;

  // Camera rotation
  float x = a_position.x * cos(yaw) + a_position.z * sin(yaw);
  float depth = -a_position.x * sin(yaw) + a_position.z * cos(yaw);
  float y = a_position.y * cos(pitch) - depth * sin(pitch);
  float z = a_position.y * sin(pitch) + depth * cos(pitch);

  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  float screenX = u_viewport.x * 0.5 + x * u_scale * zoom * perspective;
  float screenY = u_viewport.y * 0.5 - y * u_scale * zoom * perspective;

  float ndcX = (screenX / (u_viewport.x * 0.5)) - 1.0;
  float ndcY = 1.0 - (screenY / (u_viewport.y * 0.5));
  float ndcZ = clamp(z / 10000.0, -1.0, 1.0);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);
  float r = a_radius * perspective * sqrt(zoom);
  gl_PointSize = max(2.0, r * 2.0 * u_dpr * (u_picking > 0.5 ? 1.4 : 1.0));

  v_color = a_color;
  v_pickingId = a_pickingId;
}
`;

const NODE_FS = `#version 300 es
precision highp float;

in vec4 v_color;
in vec3 v_pickingId;

uniform float u_picking;
out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;

  if (u_picking > 0.5) {
    fragColor = vec4(v_pickingId, 1.0);
  } else {
    float alpha = smoothstep(0.5, 0.44, dist) * v_color.a;
    fragColor = vec4(v_color.rgb, alpha);
  }
}
`;

const EDGE_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color;

uniform vec3 u_camera;
uniform vec2 u_viewport;
uniform float u_scale;

out vec4 v_color;

void main() {
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float zoom = u_camera.z;

  float x = a_position.x * cos(yaw) + a_position.z * sin(yaw);
  float depth = -a_position.x * sin(yaw) + a_position.z * cos(yaw);
  float y = a_position.y * cos(pitch) - depth * sin(pitch);
  float z = a_position.y * sin(pitch) + depth * cos(pitch);

  float perspective = 650.0 / max(120.0, 650.0 + z * u_scale);
  float screenX = u_viewport.x * 0.5 + x * u_scale * zoom * perspective;
  float screenY = u_viewport.y * 0.5 - y * u_scale * zoom * perspective;

  float ndcX = (screenX / (u_viewport.x * 0.5)) - 1.0;
  float ndcY = 1.0 - (screenY / (u_viewport.y * 0.5));
  float ndcZ = clamp(z / 10000.0, -1.0, 1.0);

  gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);
  v_color = a_color;
}
`;

const EDGE_FS = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

/**
 * Compiles a GLSL shader.
 *
 * @param gl - WebGL2 context.
 * @param type - Shader type (VERTEX_SHADER or FRAGMENT_SHADER).
 * @param source - GLSL source code.
 * @returns Compiled WebGLShader.
 */
function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation error: ${info}`);
  }
  return shader;
}

/**
 * Links vertex and fragment shaders into a WebGLProgram.
 *
 * @param gl - WebGL2 context.
 * @param vsSource - Vertex shader GLSL source.
 * @param fsSource - Fragment shader GLSL source.
 * @returns Linked WebGLProgram.
 */
function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to allocate program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

/**
 * Encodes a 0-based node index into an RGB color tuple with an index + 1 offset
 * (index 0 is reserved for background/miss).
 *
 * @param index - 0-based node index.
 * @returns Tuple of [r, g, b] in 0-255 range.
 */
export function encodePickingColor(index: number): [number, number, number] {
  const id = index + 1;
  return [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff];
}

/**
 * Decodes an RGB pixel tuple back into a 0-based node index (-1 on miss or invalid).
 *
 * @param r - Red byte (0-255).
 * @param g - Green byte (0-255).
 * @param b - Blue byte (0-255).
 * @param a - Alpha byte (0-255).
 * @returns 0-based node index, or -1 if transparent/background.
 */
export function decodePickingColor(r: number, g: number, b: number, a: number): number {
  if (a === 0) return -1;
  const id = (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16);
  return id > 0 ? id - 1 : -1;
}

export interface WebGL2GraphRenderer {
  /**
   * Renders a frame of the 3D memory graph onto the WebGL2 canvas.
   */
  render(params: {
    camera: MemoryCamera3D;
    extent: number;
    width: number;
    height: number;
    dpr: number;
    nodePoints: Float32Array;
    nodeColors: Float32Array;
    nodeRadii: Float32Array;
    pickingIds: Float32Array;
    nodeCount: number;
    edgePoints: Float32Array;
    edgeColors: Float32Array;
    edgeVertexCount: number;
  }): void;
  /**
   * Samples a pixel from the offscreen picking framebuffer and returns the hovered node index.
   */
  pick(x: number, y: number, width: number, height: number, dpr: number): number;
  /**
   * Cleans up all GPU buffers, framebuffers, shaders, and programs.
   */
  destroy(): void;
}

/**
 * Initializes the native WebGL2 graph rendering engine and GPU picking pipeline.
 *
 * @param canvas - Target HTML canvas element.
 * @returns WebGL2GraphRenderer instance or null if WebGL2 is not supported.
 */
export function createWebGL2GraphRenderer(canvas: HTMLCanvasElement): WebGL2GraphRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance"
  });
  if (!gl) return null;

  const ctx: WebGL2RenderingContext = gl;

  let nodeProgram: WebGLProgram | null = createProgram(ctx, NODE_VS, NODE_FS);
  let edgeProgram: WebGLProgram | null = createProgram(ctx, EDGE_VS, EDGE_FS);

  // Node attributes & uniforms
  const nodeLocs = {
    pos: ctx.getAttribLocation(nodeProgram, "a_position"),
    color: ctx.getAttribLocation(nodeProgram, "a_color"),
    radius: ctx.getAttribLocation(nodeProgram, "a_radius"),
    pickingId: ctx.getAttribLocation(nodeProgram, "a_pickingId"),
    uCamera: ctx.getUniformLocation(nodeProgram, "u_camera"),
    uViewport: ctx.getUniformLocation(nodeProgram, "u_viewport"),
    uScale: ctx.getUniformLocation(nodeProgram, "u_scale"),
    uDpr: ctx.getUniformLocation(nodeProgram, "u_dpr"),
    uPicking: ctx.getUniformLocation(nodeProgram, "u_picking")
  };

  // Edge attributes & uniforms
  const edgeLocs = {
    pos: ctx.getAttribLocation(edgeProgram, "a_position"),
    color: ctx.getAttribLocation(edgeProgram, "a_color"),
    uCamera: ctx.getUniformLocation(edgeProgram, "u_camera"),
    uViewport: ctx.getUniformLocation(edgeProgram, "u_viewport"),
    uScale: ctx.getUniformLocation(edgeProgram, "u_scale")
  };

  // Buffers
  const nodeVao = ctx.createVertexArray()!;
  const nodePosBuffer = ctx.createBuffer()!;
  const nodeColorBuffer = ctx.createBuffer()!;
  const nodeRadiusBuffer = ctx.createBuffer()!;
  const nodePickingBuffer = ctx.createBuffer()!;

  const edgeVao = ctx.createVertexArray()!;
  const edgePosBuffer = ctx.createBuffer()!;
  const edgeColorBuffer = ctx.createBuffer()!;

  // Setup node VAO
  ctx.bindVertexArray(nodeVao);
  ctx.bindBuffer(ctx.ARRAY_BUFFER, nodePosBuffer);
  ctx.enableVertexAttribArray(nodeLocs.pos);
  ctx.vertexAttribPointer(nodeLocs.pos, 3, ctx.FLOAT, false, 0, 0);

  ctx.bindBuffer(ctx.ARRAY_BUFFER, nodeColorBuffer);
  ctx.enableVertexAttribArray(nodeLocs.color);
  ctx.vertexAttribPointer(nodeLocs.color, 4, ctx.FLOAT, false, 0, 0);

  ctx.bindBuffer(ctx.ARRAY_BUFFER, nodeRadiusBuffer);
  ctx.enableVertexAttribArray(nodeLocs.radius);
  ctx.vertexAttribPointer(nodeLocs.radius, 1, ctx.FLOAT, false, 0, 0);

  ctx.bindBuffer(ctx.ARRAY_BUFFER, nodePickingBuffer);
  ctx.enableVertexAttribArray(nodeLocs.pickingId);
  ctx.vertexAttribPointer(nodeLocs.pickingId, 3, ctx.FLOAT, false, 0, 0);

  // Setup edge VAO
  ctx.bindVertexArray(edgeVao);
  ctx.bindBuffer(ctx.ARRAY_BUFFER, edgePosBuffer);
  ctx.enableVertexAttribArray(edgeLocs.pos);
  ctx.vertexAttribPointer(edgeLocs.pos, 3, ctx.FLOAT, false, 0, 0);

  ctx.bindBuffer(ctx.ARRAY_BUFFER, edgeColorBuffer);
  ctx.enableVertexAttribArray(edgeLocs.color);
  ctx.vertexAttribPointer(edgeLocs.color, 4, ctx.FLOAT, false, 0, 0);

  ctx.bindVertexArray(null);

  // Framebuffer for GPU picking
  let pickingFbo: WebGLFramebuffer | null = ctx.createFramebuffer();
  let pickingTexture: WebGLTexture | null = ctx.createTexture();
  let pickingDepthRb: WebGLRenderbuffer | null = ctx.createRenderbuffer();
  let fboWidth = 0, fboHeight = 0;

  function ensurePickingFbo(w: number, h: number) {
    if (fboWidth === w && fboHeight === h && pickingFbo) return;
    fboWidth = w;
    fboHeight = h;

    ctx.bindTexture(ctx.TEXTURE_2D, pickingTexture);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA8, w, h, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, null);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);

    ctx.bindRenderbuffer(ctx.RENDERBUFFER, pickingDepthRb);
    ctx.renderbufferStorage(ctx.RENDERBUFFER, ctx.DEPTH_COMPONENT16, w, h);

    ctx.bindFramebuffer(ctx.FRAMEBUFFER, pickingFbo);
    ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, pickingTexture, 0);
    ctx.framebufferRenderbuffer(ctx.FRAMEBUFFER, ctx.DEPTH_ATTACHMENT, ctx.RENDERBUFFER, pickingDepthRb);
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
  }

  let currentNodeCount = 0;

  return {
    render(params) {
      if (!nodeProgram || !edgeProgram) return;
      const { camera, extent, width, height, dpr, nodePoints, nodeColors, nodeRadii, pickingIds, nodeCount, edgePoints, edgeColors, edgeVertexCount } = params;
      currentNodeCount = nodeCount;

      const physicalWidth = Math.round(width * dpr);
      const physicalHeight = Math.round(height * dpr);
      const scale = (Math.min(width, height) * 0.4) / extent;

      ensurePickingFbo(physicalWidth, physicalHeight);

      // Upload buffers
      ctx.bindBuffer(ctx.ARRAY_BUFFER, nodePosBuffer);
      ctx.bufferData(ctx.ARRAY_BUFFER, nodePoints.subarray(0, nodeCount * 3), ctx.DYNAMIC_DRAW);

      ctx.bindBuffer(ctx.ARRAY_BUFFER, nodeColorBuffer);
      ctx.bufferData(ctx.ARRAY_BUFFER, nodeColors.subarray(0, nodeCount * 4), ctx.DYNAMIC_DRAW);

      ctx.bindBuffer(ctx.ARRAY_BUFFER, nodeRadiusBuffer);
      ctx.bufferData(ctx.ARRAY_BUFFER, nodeRadii.subarray(0, nodeCount), ctx.DYNAMIC_DRAW);

      ctx.bindBuffer(ctx.ARRAY_BUFFER, nodePickingBuffer);
      ctx.bufferData(ctx.ARRAY_BUFFER, pickingIds.subarray(0, nodeCount * 3), ctx.DYNAMIC_DRAW);

      if (edgeVertexCount > 0) {
        ctx.bindBuffer(ctx.ARRAY_BUFFER, edgePosBuffer);
        ctx.bufferData(ctx.ARRAY_BUFFER, edgePoints.subarray(0, edgeVertexCount * 3), ctx.DYNAMIC_DRAW);

        ctx.bindBuffer(ctx.ARRAY_BUFFER, edgeColorBuffer);
        ctx.bufferData(ctx.ARRAY_BUFFER, edgeColors.subarray(0, edgeVertexCount * 4), ctx.DYNAMIC_DRAW);
      }

      // Main drawing pass
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
      ctx.viewport(0, 0, physicalWidth, physicalHeight);
      ctx.clearColor(0.0, 0.0, 0.0, 0.0);
      ctx.clearDepth(1.0);
      ctx.clear(ctx.COLOR_BUFFER_BIT | ctx.DEPTH_BUFFER_BIT);

      ctx.enable(ctx.DEPTH_TEST);
      ctx.depthFunc(ctx.LEQUAL);
      ctx.enable(ctx.BLEND);
      ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);

      // 1. Draw Edges
      if (edgeVertexCount > 0) {
        ctx.useProgram(edgeProgram);
        ctx.uniform3f(edgeLocs.uCamera, camera.yaw, camera.pitch, camera.zoom);
        ctx.uniform2f(edgeLocs.uViewport, width, height);
        ctx.uniform1f(edgeLocs.uScale, scale);

        ctx.bindVertexArray(edgeVao);
        ctx.drawArrays(ctx.LINES, 0, edgeVertexCount);
      }

      // 2. Draw Nodes
      if (nodeCount > 0) {
        ctx.useProgram(nodeProgram);
        ctx.uniform3f(nodeLocs.uCamera, camera.yaw, camera.pitch, camera.zoom);
        ctx.uniform2f(nodeLocs.uViewport, width, height);
        ctx.uniform1f(nodeLocs.uScale, scale);
        ctx.uniform1f(nodeLocs.uDpr, dpr);
        ctx.uniform1f(nodeLocs.uPicking, 0.0);

        ctx.bindVertexArray(nodeVao);
        ctx.drawArrays(ctx.POINTS, 0, nodeCount);
      }

      ctx.bindVertexArray(null);
    },

    pick(x, y, width, height, dpr) {
      if (!nodeProgram || currentNodeCount === 0 || !pickingFbo) return -1;
      const physicalWidth = Math.round(width * dpr);
      const physicalHeight = Math.round(height * dpr);
      const px = Math.round(x * dpr);
      const py = Math.round((height - y) * dpr);
      if (px < 0 || px >= physicalWidth || py < 0 || py >= physicalHeight) return -1;

      // Fast render to picking FBO
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, pickingFbo);
      ctx.viewport(0, 0, physicalWidth, physicalHeight);
      ctx.clearColor(0.0, 0.0, 0.0, 0.0);
      ctx.clearDepth(1.0);
      ctx.clear(ctx.COLOR_BUFFER_BIT | ctx.DEPTH_BUFFER_BIT);

      ctx.enable(ctx.DEPTH_TEST);
      ctx.depthFunc(ctx.LEQUAL);
      ctx.disable(ctx.BLEND);

      ctx.useProgram(nodeProgram);
      ctx.uniform1f(nodeLocs.uPicking, 1.0);

      ctx.bindVertexArray(nodeVao);
      ctx.drawArrays(ctx.POINTS, 0, currentNodeCount);
      ctx.bindVertexArray(null);

      const pixel = new Uint8Array(4);
      ctx.readPixels(px, py, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel);
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);

      const index = decodePickingColor(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0);
      return index >= 0 && index < currentNodeCount ? index : -1;
    },

    destroy() {
      if (pickingFbo) ctx.deleteFramebuffer(pickingFbo);
      if (pickingTexture) ctx.deleteTexture(pickingTexture);
      if (pickingDepthRb) ctx.deleteRenderbuffer(pickingDepthRb);
      ctx.deleteBuffer(nodePosBuffer);
      ctx.deleteBuffer(nodeColorBuffer);
      ctx.deleteBuffer(nodeRadiusBuffer);
      ctx.deleteBuffer(nodePickingBuffer);
      ctx.deleteBuffer(edgePosBuffer);
      ctx.deleteBuffer(edgeColorBuffer);
      ctx.deleteVertexArray(nodeVao);
      ctx.deleteVertexArray(edgeVao);
      if (nodeProgram) ctx.deleteProgram(nodeProgram);
      if (edgeProgram) ctx.deleteProgram(edgeProgram);
      nodeProgram = null;
      edgeProgram = null;
    }
  };
}
