export const SESSION_ID_ANNOTATION = "popcorn.dev/session-id";
export const SESSION_BOUND_AT_ANNOTATION = "popcorn.dev/session-bound-at";
export const SESSION_BOUND_AT_UNIX_NANO_ANNOTATION = "popcorn.dev/session-bound-at-unix-nano";

export interface SessionMetadata {
    annotations: Record<string, string>;
    boundAt: string;
    boundAtUnixNano: string;
}

export function unixNanoFromDate(date: Date): string {
    return (BigInt(date.getTime()) * 1000000n).toString();
}

export function buildSessionMetadata(sessionId: string, boundAtDate = new Date()): SessionMetadata {
    const boundAt = boundAtDate.toISOString();
    const boundAtUnixNano = unixNanoFromDate(boundAtDate);

    return {
        annotations: {
            [SESSION_ID_ANNOTATION]: sessionId,
            [SESSION_BOUND_AT_ANNOTATION]: boundAt,
            [SESSION_BOUND_AT_UNIX_NANO_ANNOTATION]: boundAtUnixNano,
        },
        boundAt,
        boundAtUnixNano,
    };
}
