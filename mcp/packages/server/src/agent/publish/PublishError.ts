/**
 * Stable codes of publish failures; the client words them for the user (`penforge.publish.error.<code>`).
 *
 * - `no-app`: the project has no generated app yet
 * - `not-connected`: the provider account is not connected
 * - `token-invalid`: the provider refused the token (wrong, expired or revoked)
 * - `token-scope`: the token lacks a permission the step needs
 * - `token-format`: the text does not look like a token of that provider
 * - `name-taken`: the repository or site name is used by someone else
 * - `repo-diverged`: the GitHub repository has commits the app does not have
 * - `build-failed`: the app's build command failed
 * - `no-output`: the build left no folder with an `index.html`
 * - `too-large`: the app or its build output is over the size limit
 * - `deploy-failed`: the provider reported a failed deployment
 * - `timeout`: the provider did not finish in time
 * - `network`: the provider could not be reached
 * - `rate-limited`: the provider asks to wait
 * - `provider`: any other provider error
 * - `no-phone-preview`: the stack has no phone preview (only Expo has one)
 * - `no-network`: this computer has no local network address for the phone
 * - `preview-failed`: the dev server for the phone did not start
 * - `busy`: another publish step of the project is running
 * - `cancelled`: the user said no or stopped it
 */
export type PublishErrorCode =
    | "no-app"
    | "not-connected"
    | "token-invalid"
    | "token-scope"
    | "token-format"
    | "name-taken"
    | "repo-diverged"
    | "build-failed"
    | "no-output"
    | "too-large"
    | "deploy-failed"
    | "timeout"
    | "network"
    | "rate-limited"
    | "provider"
    | "no-phone-preview"
    | "no-network"
    | "preview-failed"
    | "busy"
    | "cancelled";

/**
 * Failure of a publish step, with a stable code and an English message.
 *
 * The message never holds a token: provider answers are reduced to their status and error text,
 * and every text passes through {@link SecretMask} before it is shown or logged.
 */
export class PublishError extends Error {
    /**
     * @param code - stable code (see {@link PublishErrorCode})
     * @param message - English text for logs and the developer persona
     * @param params - values the client may put into its wording (provider, name, …)
     * @param detail - technical detail for developers (provider answer, build output)
     */
    constructor(
        public readonly code: PublishErrorCode,
        message: string,
        public readonly params: Record<string, string> = {},
        public readonly detail?: string
    ) {
        super(message);
        this.name = "PublishError";
    }
}

/**
 * Remover of secrets from texts that leave the daemon (events, logs, error messages).
 *
 * Replaces the known tokens and anything shaped like a provider token or an `Authorization`
 * value with `***`.
 */
export class SecretMask {
    private static readonly PATTERNS = [
        /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        /\bnfp_[A-Za-z0-9]{20,}\b/g,
        /(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"',;]+/gi,
        /(x-access-token:)[^@\s"']+/gi,
    ];

    /**
     * @param secrets - gets the stored tokens, which are always masked
     */
    constructor(private readonly secrets: () => readonly string[] = () => []) {}

    /**
     * Masks a text.
     *
     * @param text - any text
     */
    public mask(text: string): string {
        let result = text;
        for (const secret of this.secrets()) {
            if (secret.length >= 8) {
                result = result.split(secret).join("***");
            }
        }
        for (const pattern of SecretMask.PATTERNS) {
            result = result.replace(pattern, (match, prefix?: string) =>
                typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}***` : "***"
            );
        }
        return result;
    }
}
