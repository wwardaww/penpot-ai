/** Frontend flags of the desktop app (`penpotFlags`). */
export const FRONTEND_FLAGS = [
    "enable-ai",
    "enable-mcp",
    "enable-access-tokens",
    "disable-registration",
    "disable-login-with-password",
    "disable-email-verification",
    "disable-secure-session-cookies",
    "disable-admin-console",
];

export interface ConfigJsParams {
    origin: string;
    agentPort: number;
    bridgePort: number;
    version: string;
    flags?: string[];
}

/** Contents of `/js/config.js`, the frontend's runtime configuration (globals). */
export function configJs(params: ConfigJsParams): string {
    const values: [string, string | boolean][] = [
        ["penpotPublicURI", params.origin],
        ["penpotFlags", (params.flags ?? FRONTEND_FLAGS).join(" ")],
        ["penforgeAgentURI", `ws://127.0.0.1:${params.agentPort}/agent`],
        ["penforgeMcpBridgeURI", `ws://127.0.0.1:${params.bridgePort}`],
        ["penforgeDesktop", true],
        ["penforgeDesktopVersion", params.version],
    ];
    return values.map(([name, value]) => `var ${name} = ${JSON.stringify(value)};`).join("\n") + "\n";
}
