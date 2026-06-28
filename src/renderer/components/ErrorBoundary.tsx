import React from 'react';
import { getErrorMessage } from '../utils/errors';

interface ErrorBoundaryProps {
    children: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    message: string;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { hasError: false, message: '' };

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return { hasError: true, message: getErrorMessage(error) };
    }

    componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
        console.error('Renderer error boundary caught an error:', error, errorInfo);
    }

    handleReload = (): void => {
        window.location.reload();
    };

    render(): React.ReactNode {
        if (!this.state.hasError) {
            return this.props.children;
        }

        return (
            <div className="flex min-h-screen items-center justify-center bg-[#10141a] px-4">
                <div className="clean-panel w-full max-w-md p-8 text-center">
                    <h2 className="mb-2 text-2xl font-bold text-white">Something went wrong</h2>
                    <p className="mb-6 text-sm text-slate-400">
                        {this.state.message || 'An unexpected error occurred.'}
                    </p>
                    <button
                        onClick={this.handleReload}
                        className="clean-button clean-button-soft px-4 py-2"
                    >
                        Reload
                    </button>
                </div>
            </div>
        );
    }
}

export default ErrorBoundary;
