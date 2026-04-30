export type SerializedTraceError = {
  error_name: string | null;
  error_message: string | null;
  error_stack_preview: string | null;
};

export function serializeErrorForTrace(error: unknown): SerializedTraceError {
  try {
    if (error instanceof Error) {
      return {
        error_name: error.name || null,
        error_message: error.message || null,
        error_stack_preview:
          typeof error.stack === "string" ? error.stack.slice(0, 1000) : null,
      };
    }

    let message: string | null = null;
    try {
      if (typeof error === "string") {
        message = error;
      } else {
        const json = JSON.stringify(error);
        message = typeof json === "string" ? json : String(error);
      }
    } catch {
      message = "non-error thrown value could not be serialized";
    }

    return {
      error_name: null,
      error_message: message,
      error_stack_preview: null,
    };
  } catch {
    return {
      error_name: null,
      error_message: null,
      error_stack_preview: null,
    };
  }
}
