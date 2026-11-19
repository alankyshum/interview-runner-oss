// Includes runner startup as well as test execution, including cold sandbox starts.
export const COURSE_TEST_TIMEOUT_MS = 15_000;
export const courseTestTimeoutMessage = (timeoutMs = COURSE_TEST_TIMEOUT_MS) => `Tests stopped after ${timeoutMs / 1_000}s. Your code may have an infinite loop.`;
