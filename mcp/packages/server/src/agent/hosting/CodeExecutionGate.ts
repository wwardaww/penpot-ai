import { AgentError } from "../AgentClient";

/**
 * Process-wide switch that stops the daemon from running generated code (dev servers, build
 * commands) on its own machine.
 *
 * Server mode closes it: generated apps must run in the sandbox, never in the daemon container
 * that holds every team's folders and the master key. Local mode leaves it open.
 */
export class CodeExecutionGate {
    private static refusal: string | null = null;

    /**
     * Refuses every later run.
     *
     * @param reason - English text for the user
     */
    public static close(reason: string): void {
        CodeExecutionGate.refusal = reason;
    }

    /** Allows runs again (tests, daemon stop). */
    public static open(): void {
        CodeExecutionGate.refusal = null;
    }

    /**
     * Checks that generated code may run here.
     *
     * @throws AgentError `not-configured` while the gate is closed
     */
    public static check(): void {
        if (CodeExecutionGate.refusal !== null) {
            throw new AgentError("not-configured", CodeExecutionGate.refusal);
        }
    }
}
