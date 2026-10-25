import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "../ui-theme/app-icons.js";

type MemoryGraphErrorBoundaryProps = {
  children: ReactNode;
};

type MemoryGraphErrorBoundaryState = {
  error: string | null;
  retryKey: number;
};

export class MemoryGraphErrorBoundary extends Component<MemoryGraphErrorBoundaryProps, MemoryGraphErrorBoundaryState> {
  state: MemoryGraphErrorBoundaryState = {
    error: null,
    retryKey: 0
  };

  static getDerivedStateFromError(error: unknown): Partial<MemoryGraphErrorBoundaryState> {
    return {
      error: error instanceof Error ? error.message : "The memory map could not be displayed."
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Memory graph panel render failed.", error, info.componentStack);
  }

  private retry = () => {
    this.setState((current) => ({ error: null, retryKey: current.retryKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <section className="memory-graph-panel memory-graph-boundary-error" aria-label="Memory map unavailable">
          <div className="memory-graph-boundary-message" role="alert">
            <AlertTriangle aria-hidden="true" />
            <h3>Memory map could not be displayed</h3>
            <p>The rest of the memory workspace is still available. Retry only the map panel.</p>
          </div>
          <button type="button" aria-label="Retry memory graph panel" onClick={this.retry}>
            <RotateCcw aria-hidden="true" />
            Retry map
          </button>
        </section>
      );
    }

    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
