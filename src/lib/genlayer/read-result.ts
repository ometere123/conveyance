export type ReadFailureKind = "UNAVAILABLE" | "INVALID_RESPONSE";

export type ReadResult<T> =
  | { kind: "AVAILABLE"; value: T }
  | { kind: "NOT_FOUND" }
  | { kind: ReadFailureKind; error: string };

export const available = <T>(value: T): ReadResult<T> => ({ kind: "AVAILABLE", value });
export const notFound = <T>(): ReadResult<T> => ({ kind: "NOT_FOUND" });
export const unavailable = <T>(error: unknown): ReadResult<T> => ({
  kind: "UNAVAILABLE",
  error: error instanceof Error ? error.message : String(error),
});
export const invalidResponse = <T>(error: string): ReadResult<T> => ({
  kind: "INVALID_RESPONSE",
  error,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function performRead<T>(
  read: () => Promise<unknown>,
  validate: (value: unknown) => value is T,
  invalidMessage: string,
): Promise<ReadResult<T>> {
  try {
    const value = await read();
    return validate(value) ? available(value) : invalidResponse(invalidMessage);
  } catch (error) {
    return unavailable(error);
  }
}
