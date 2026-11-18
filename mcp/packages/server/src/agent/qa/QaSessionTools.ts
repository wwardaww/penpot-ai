import type { WorkflowToolResult, WorkflowToolsApi } from "@penpot/mcp-common";

/**
 * Penpot tools of a QA run, routed to the browser tab of the right file.
 *
 * A context without `mcpSessionId` (scripts, a tab whose plugin connected late) makes every tool
 * fail with "Multiple Penpot sessions are connected" as soon as two tabs are open. That error
 * lists the sessions with their files; this wrapper picks the session of the run's file from the
 * list, retries once with it and keeps using it. Another file open in every tab stays an error.
 */
export class QaSessionTools implements WorkflowToolsApi {
    /** `<sessionId>: "<file name>" (file <fileId>)` lines of the dispatcher's error */
    private static readonly SESSION_LINE = /^\s*(\S+): .*\(file ([^)\s]+)\)\s*$/;
    private sessionId: string | undefined;

    /**
     * @param tools - the tools of the run (the tab's session id, if known, is added by them)
     * @param fileId - the file the run is about
     * @param sessionId - a session to use from the start (e.g. passed by Claude to a chat tool)
     */
    constructor(
        private readonly tools: WorkflowToolsApi,
        private readonly fileId: string,
        sessionId?: string
    ) {
        this.sessionId = sessionId;
    }

    public async call(toolName: string, args: Record<string, unknown> = {}): Promise<WorkflowToolResult> {
        const withSession = this.withSession(args);
        const result = await this.tools.call(toolName, withSession);
        if (!result.isError || withSession.sessionId !== undefined) {
            return result;
        }
        const sessionId = QaSessionTools.sessionOfFile(result.text, this.fileId);
        if (!sessionId) {
            return result;
        }
        this.sessionId = sessionId;
        return this.tools.call(toolName, { ...args, sessionId });
    }

    public list(): Promise<string[]> {
        return this.tools.list();
    }

    /**
     * Finds the session of a file in a "Multiple Penpot sessions are connected" error.
     *
     * @returns the session id, or null when the error is another one or no single session shows the file
     */
    public static sessionOfFile(errorText: string, fileId: string): string | null {
        if (!errorText.includes("Multiple Penpot sessions are connected")) {
            return null;
        }
        const matches = errorText
            .split(/\r?\n/)
            .map((line) => QaSessionTools.SESSION_LINE.exec(line))
            .filter((match): match is RegExpExecArray => match !== null && match[2] === fileId)
            .map((match) => match[1]);
        // the same file in two tabs: either session reads the same design
        return matches[0] ?? null;
    }

    private withSession(args: Record<string, unknown>): Record<string, unknown> {
        return this.sessionId && args.sessionId === undefined ? { ...args, sessionId: this.sessionId } : args;
    }
}
