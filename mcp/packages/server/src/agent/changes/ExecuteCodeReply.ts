/**
 * Parser of the text the `execute_code` MCP tool answers with: the plugin's `{result, log}`
 * envelope as JSON, sometimes followed by a blank line and a note about a slow call.
 */
export class ExecuteCodeReply {
    /**
     * Returns the value the plugin code returned.
     *
     * @param text - the tool's text
     * @throws Error when the text holds no JSON
     */
    public static parse(text: string): unknown {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            // a slow call appends "\n\nNOTE: …" after the JSON
            const end = text.lastIndexOf("\n}\n\n");
            if (end < 0) {
                throw new Error(`execute_code returned no JSON: ${text.slice(0, 200)}`);
            }
            parsed = JSON.parse(text.slice(0, end + 2));
        }
        if (parsed !== null && typeof parsed === "object" && "result" in parsed && "log" in parsed) {
            return (parsed as { result: unknown }).result;
        }
        return parsed;
    }
}
