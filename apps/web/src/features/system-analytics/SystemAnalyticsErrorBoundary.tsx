import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "../ui-theme/app-icons.js";

type SystemAnalyticsErrorBoundaryProps = {
  children: ReactNode;
  onClose: () => void;
};

type SystemAnalyticsErrorBoundaryState = {
  error: string | null;
  retryKey: number;
};

export class SystemAnalyticsErrorBoundary extends Component<SystemAnalyticsErrorBoundaryProps, SystemAnalyticsErrorBoundaryState> {
  state: SystemAnalyticsErrorBoundaryState = {
    error: null,
    retryKey: 0
  };

  static getDerivedStateFromError(error: unknown): Partial<SystemAnalyticsErrorBoundaryState> {
    return {
      error: error instanceof Error ? error.message : "System analytics could not be displayed."
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("System analytics workspace render failed.", error, info.componentStack);
  }

  private retry = () => {
    this.setState((current) => ({ error: null, retryKey: current.retryKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <section className="system-analytics-workspace system-analytics-boundary-error" aria-label="System analytics unavailable">
          <div className="system-analytics-boundary-message" role="alert">
            <AlertTriangle aria-hidden="true" />
            <h3>System analytics could not be displayed</h3>
            <p>The rest of the app is still available. Retry the analytics workspace.</p>
          </div>
          <div className="system-analytics-boundary-actions">
            <button type="button" aria-label="Retry system analytics" onClick={this.retry}>
              <RotateCcw aria-hidden="true" />
              Retry
            </button>
            <button type="button" aria-label="Close system analytics" onClick={this.props.onClose}>
              Close
            </button>
          </div>
        </section>
      );
    }

    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}