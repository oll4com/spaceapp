import { Component, Suspense, type ReactNode } from "react";
import { isStaleBuildLoadError } from "../entry-load-recovery.js";

/** Contain a page/dock failure without unmounting sibling pane runtimes. */
export class SurfaceErrorBoundary extends Component<{
  children: ReactNode;
  resetKey?: string;
}, { error: unknown; failed: boolean }> {
  state: { error: unknown; failed: boolean } = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }

  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey?: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ error: null, failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const stale = isStaleBuildLoadError(this.state.error);
    return <section role="alert" className="surface-load-error">
      <strong>This view could not load</strong>
      <p>{stale ? "A required file is unavailable. Reload Space to get the latest version." : "Try opening this view again. If the problem continues, reload Space."}</p>
      {!stale && <button type="button" onClick={() => this.setState({ error: null, failed: false })}>Try again</button>}
      <button type="button" onClick={() => window.location.reload()}>Reload Space</button>
    </section>;
  }
}

export function RecoverableSurface({ children, fallback, resetKey }: { children: ReactNode; fallback: ReactNode; resetKey?: string }) {
  return <SurfaceErrorBoundary resetKey={resetKey}><Suspense fallback={fallback}>{children}</Suspense></SurfaceErrorBoundary>;
}
