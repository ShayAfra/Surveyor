interface InlineErrorProps {
  message: string;
  /** When provided, renders a Retry button that invokes this callback. */
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * Minimal inline error surface: an assertive alert with an optional Retry
 * button. It renders exactly where it is placed (no portal, no toast, no global
 * state), so a failed load or action stays visible in its own context. Styling
 * is kept to the shared `.inline-error` class for basic readability only.
 */
export default function InlineError({ message, onRetry, retryLabel = "Retry" }: InlineErrorProps) {
  return (
    <div role="alert" className="inline-error">
      <span>{message}</span>
      {onRetry != null && (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
