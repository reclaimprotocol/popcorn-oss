interface RetryOptions<T> {
    attempts: number;
    delayMs: number;
    shouldRetryResult?: (result: T) => boolean;
}

function sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retry<T>(
    operation: () => Promise<T>,
    options: RetryOptions<T>,
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= options.attempts; attempt++) {
        try {
            const result = await operation();

            if (attempt < options.attempts && options.shouldRetryResult?.(result)) {
                await sleep(options.delayMs);
                continue;
            }

            return result;
        } catch (error) {
            lastError = error;

            if (attempt === options.attempts) {
                throw error;
            }

            await sleep(options.delayMs);
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Retry operation failed");
}
