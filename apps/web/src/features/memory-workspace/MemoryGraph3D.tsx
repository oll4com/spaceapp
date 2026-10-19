import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_MEMORY_CAMERA, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { capSceneForFallback, type MemoryScene } from "./memory-scene.js";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemorySceneStream } from "./memory-layout-stream.js";
import { chooseRenderer, probeWebGL2 } from "./memory-renderer-select.js";
import { MemoryGraph3DGL, type MemoryGLStatus } from "./MemoryGraph3DGL.js";
import { MemoryGraph3DCanvas2D } from "./MemoryGraph3DCanvas2D.js";
import { volumeRatioFromArrays } from "./memory-volume.js";

/**
 * 3D memory view. WebGL2 renders the full streamed scene; without WebGL2, after a shader failure, or while the
 * context is lost, a fresh Canvas 2D element renders a capped copy (2,000 nodes / 6,000 edges) and the GL canvas
 * stays mounted (hidden) so a restored context can switch back.
 */
export function MemoryGraph3D({ stream, scene, showTitles, selectedNodeId, onSelectNode, loading, resetToken, error = null }: {
  stream: MemorySceneStream | null; scene: MemoryScene | null;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
  /** A failed fetch or worker error; shown over the canvas so the view is never silently empty. */
  error?: string | null;
}) {
  const [supported] = useState(() => probeWebGL2());
  const [status, setStatus] = useState<MemoryGLStatus>({ failed: false, lost: false });
  const onStatus = useCallback((next: MemoryGLStatus) => setStatus(previous => previous.failed === next.failed && previous.lost === next.lost ? previous : next), []);
  const mode = chooseRenderer({ webgl2Supported: supported, shaderFailed: status.failed, contextLost: status.lost });
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });

  // Re-render for the layout volume at the first snapshot and at completion only, not for every snapshot.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!stream) return;
    let first = false, done = false;
    return stream.subscribe(() => {
      if ((stream.x && !first) || (stream.done && !done)) { first = Boolean(stream.x); done = stream.done; setTick(value => value + 1); }
      else if (mode === "canvas2d" && stream.x) setTick(value => value + 1);
    });
  }, [stream, mode]);
  const volume = useMemo(() => stream?.x ? volumeRatioFromArrays(stream.x, stream.y!, stream.z!, scene?.count ?? 0).toFixed(4) : (0).toFixed(4),
    [stream, scene, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const fallback = useMemo(() => {
    if (mode !== "canvas2d" || !scene || !stream?.x) return null;
    const capped = capSceneForFallback(scene);
    const positions = new Map<string, MemoryAtlasPosition>(capped.indices.map(index => [scene.ids[index]!, { x: 0, y: 0, hub: false, groupId: "", color: `#${[0, 1, 2].map(c => scene.rgb[index * 3 + c]!.toString(16).padStart(2, "0")).join("")}` }]));
    const coordinates = new Map<string, MemoryPoint3D>(capped.indices.map(index => [scene.ids[index]!, { x: stream.x![index]!, y: stream.y![index]!, z: stream.z![index]! }]));
    return { nodes: capped.nodes, edges: capped.edges, positions, coordinates };
  }, [mode, scene, stream, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="memory-3d-surface" data-renderer={mode}>
    {supported ? <MemoryGraph3DGL stream={stream} scene={scene} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} loading={loading} resetToken={resetToken} volume={volume} hidden={mode !== "webgl"} cameraRef={cameraRef} onStatus={onStatus} /> : null}
    {mode === "canvas2d" ? <MemoryGraph3DCanvas2D nodes={fallback?.nodes ?? []} edges={fallback?.edges ?? []} positions={fallback?.positions ?? EMPTY_POSITIONS} coordinates={fallback?.coordinates ?? EMPTY_COORDINATES} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} loading={loading} resetToken={resetToken} volume={volume} cameraRef={cameraRef} /> : null}
    {error ? <div className="memory-3d-error" role="alert"><strong>The 3D memory graph could not be loaded.</strong><span>{error}</span></div> : null}
    <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
  </div>;
}
const EMPTY_POSITIONS = new Map<string, MemoryAtlasPosition>(), EMPTY_COORDINATES = new Map<string, MemoryPoint3D>();
