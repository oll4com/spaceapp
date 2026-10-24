/**
 * Native WebGL2 instanced renderer for SpaceApp's 3D Memory Graph (#62).
 * Zero external 3D dependencies: uses raw WebGL2 instanced quads for nodes,
 * batched GL_LINES for edges, and GPU depth testing for 50,000+ nodes at 60 FPS.
 */

const NODE_VERT_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQuadCorner;
layout(location = 1) in vec3 aScreenPos; // x (px), y (px), depthZ
layout(location = 2) in float aRadius;
layout(location = 3) in vec4 aColor;

uniform vec2 uViewport;

out vec2 vCorner;
out vec4 vColor;

void main() {
  vCorner = aQuadCorner;
  vColor = aColor;
  vec2 posPx = aScreenPos.xy + aQuadCorner * aRadius;
  vec2 clipXY = (posPx / uViewport) * 2.0 - 1.0;
  clipXY.y = -clipXY.y;
  float clipZ = clamp(aScreenPos.z / 2000.0, -0.99, 0.99);
  gl_Position = vec4(clipXY, clipZ, 1.0);
}
`;

const NODE_FRAG_SHADER = `#version 300 es
precision mediump float;
in vec2 vCorner;
in vec4 vColor;
out vec4 outColor;

void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  float alpha = vColor.a * smoothstep(1.0, 0.72, r2);
  outColor = vec4(vColor.rgb, alpha);
}
`;

const EDGE_VERT_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;

uniform vec2 uViewport;
out vec4 vColor;

void main() {
  vColor = aColor;
  vec2 clipXY = (aPos.xy / uViewport) * 2.0 - 1.0;
  clipXY.y = -clipXY.y;
  float clipZ = clamp(aPos.z / 2000.0, -0.99, 0.99);
  gl_Position = vec4(clipXY, clipZ, 1.0);
}
`;

const EDGE_FRAG_SHADER = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;

void main() {
  outColor = vColor;
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function parseCssColorToRgba(hex: string, alpha = 1): [number, number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 6) {
    const num = Number.parseInt(clean, 16);
    return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255, alpha];
  }
  return [0.45, 0.58, 0.68, alpha];
}

export class NativeWebGL2GraphRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly nodeProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly edgeVao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly edgeBuffer: WebGLBuffer;

  private constructor(
    gl: WebGL2RenderingContext,
    nodeProgram: WebGLProgram,
    edgeProgram: WebGLProgram,
    nodeVao: WebGLVertexArrayObject,
    edgeVao: WebGLVertexArrayObject,
    instanceBuffer: WebGLBuffer,
    edgeBuffer: WebGLBuffer
  ) {
    this.gl = gl;
    this.nodeProgram = nodeProgram;
    this.edgeProgram = edgeProgram;
    this.nodeVao = nodeVao;
    this.edgeVao = edgeVao;
    this.instanceBuffer = instanceBuffer;
    this.edgeBuffer = edgeBuffer;
  }

  static tryCreate(canvas: HTMLCanvasElement): NativeWebGL2GraphRenderer | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
    } catch {
      return null;
    }
    if (!gl || typeof gl.createVertexArray !== "function") return null;
    const nodeProgram = createProgram(gl, NODE_VERT_SHADER, NODE_FRAG_SHADER);
    const edgeProgram = createProgram(gl, EDGE_VERT_SHADER, EDGE_FRAG_SHADER);
    const nodeVao = gl.createVertexArray();
    const edgeVao = gl.createVertexArray();
    const quadBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    const edgeBuffer = gl.createBuffer();
    if (!nodeProgram || !edgeProgram || !nodeVao || !edgeVao || !quadBuffer || !instanceBuffer || !edgeBuffer) {
      return null;
    }

    gl.bindVertexArray(nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 3 * 4);
    gl.vertexAttribDivisor(2, 1);

    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 4 * 4);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
    const edgeStride = 7 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, edgeStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, edgeStride, 3 * 4);

    gl.bindVertexArray(null);
    return new NativeWebGL2GraphRenderer(gl, nodeProgram, edgeProgram, nodeVao, edgeVao, instanceBuffer, edgeBuffer);
  }

  draw(width: number, height: number, dpr: number, nodeData: Float32Array, nodeCount: number, edgeData: Float32Array, edgeVertexCount: number): void {
    const { gl } = this;
    gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr));
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (edgeVertexCount > 0) {
      gl.useProgram(this.edgeProgram);
      gl.uniform2f(gl.getUniformLocation(this.edgeProgram, "uViewport"), width, height);
      gl.bindVertexArray(this.edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, edgeData.subarray(0, edgeVertexCount * 7), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, edgeVertexCount);
    }

    if (nodeCount > 0) {
      gl.useProgram(this.nodeProgram);
      gl.uniform2f(gl.getUniformLocation(this.nodeProgram, "uViewport"), width, height);
      gl.bindVertexArray(this.nodeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, nodeData.subarray(0, nodeCount * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, nodeCount);
    }

    gl.bindVertexArray(null);
  }
}
