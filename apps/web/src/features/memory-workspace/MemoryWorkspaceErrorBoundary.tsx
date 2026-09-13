import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "../ui-theme/app-icons.js";

type MemoryWorkspaceErrorBoundaryProps = {
  children: ReactNode;
  onClose: () => void;
};

type MemoryWorkspaceErrorBoundaryState = {
  error: string | null;
  retryKey: number;
};

export class MemoryWorkspaceErrorBoundary extends Component<MemoryWorkspaceErrorBoundaryProps, MemoryWorkspaceErrorBoundaryState> {
  state: MemoryWorkspaceErrorBoundaryState = {
    error: null,
    retryKey: 0
  };

  static getDerivedStateFromError(error: unknown): Partial<MemoryWorkspaceErrorBoundaryState> {
    return {
      error: error instanceof Error ? error.message : "The memory workspace could not be displayed."
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Memory workspace render failed.", error, info.componentStack);
  }

  private retry = () => {
    this.setState((current) => ({ error: null, retryKey: current.retryKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <section className="memory-workspace memory-graph-boundary-error" aria-label="Memory workspace unavailable">
          <div className="memory-graph-boundary-message" role="alert">
            <AlertTriangle aria-hidden="true" />
            <h3>Memory workspace could not be displayed</h3>
            <p>The workspace hit an unexpected error. Retry, or close and reopen it.</p>
          </div>
          <button type="button" aria-label="Retry memory workspace" onClick={this.retry}>
            <RotateCcw aria-hidden="true" />
            Retry
          </button>
          <button type="button" aria-label="Close memory workspace" onClick={this.props.onClose}>
            Close
          </button>
        </section>
      );
    }

    return <div key={this.state.retryKey} className="memory-workspace-root">{this.props.children}</div>;
  }
}
