import type { IncomingHttpHeaders } from "node:http";

/**
 * Header with which an MCP client asks for a layout check after every `execute_code` call that it
 * makes. Penforge sends it for models that cannot judge their own drawing well; other clients get
 * the plain result.
 */
export class LayoutCheckHeader {
    private static readonly NAME = "x-penforge-layout-check";

    /** The header, for the client's requests. */
    public static readonly HEADERS: Readonly<Record<string, string>> = { [LayoutCheckHeader.NAME]: "1" };

    /**
     * Whether a request asks for the check.
     *
     * @param headers - the headers of the request
     */
    public static isSet(headers: IncomingHttpHeaders): boolean {
        return headers[LayoutCheckHeader.NAME] === "1";
    }
}
