"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex items-center justify-center h-screen bg-gray-950">
            <div className="max-w-lg w-full mx-4 border border-red-800 rounded-xl bg-red-950/40 p-6">
              <h2 className="text-red-400 font-semibold text-lg mb-2">
                Something went wrong
              </h2>
              <pre className="text-red-300 text-xs font-mono whitespace-pre-wrap break-all bg-gray-950 rounded p-3 max-h-64 overflow-auto">
                {this.state.error.message}
              </pre>
              <button
                onClick={() => this.setState({ error: null })}
                className="mt-4 px-4 py-1.5 bg-red-800 hover:bg-red-700 text-white text-sm rounded transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
