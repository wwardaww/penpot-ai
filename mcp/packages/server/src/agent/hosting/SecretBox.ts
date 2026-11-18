import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

/**
 * Authenticated encryption of server secrets with the install's master key (AES-256-GCM).
 *
 * A sealed value is `v1.<iv>.<tag>.<ciphertext>` (base64url parts). The purpose string is bound
 * as additional data, so a value sealed for one slot (e.g. one team's API key) cannot be moved
 * to another slot.
 */
export class SecretBox {
    private static readonly VERSION = "v1";

    /**
     * @param key - the master key (32 bytes)
     */
    constructor(private readonly key: Buffer) {
        if (key.length !== 32) {
            throw new Error("The master key must be 32 bytes");
        }
    }

    /**
     * Encrypts a value.
     *
     * @param plaintext - the secret
     * @param purpose - the slot the secret belongs to
     */
    public seal(plaintext: string, purpose: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from(purpose, "utf8"));
        const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [SecretBox.VERSION, iv, tag, data]
            .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
            .join(".");
    }

    /**
     * Decrypts a value.
     *
     * @param sealed - the value from {@link seal}
     * @param purpose - the slot the secret belongs to
     * @throws Error when the value is malformed, was sealed with another key or for another slot
     */
    public open(sealed: string, purpose: string): string {
        const parts = sealed.split(".");
        if (parts.length !== 4 || parts[0] !== SecretBox.VERSION) {
            throw new Error("Malformed sealed secret");
        }
        const [iv, tag, data] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
        const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
        decipher.setAAD(Buffer.from(purpose, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    }

    /**
     * Derives a stable keyed digest (HMAC-SHA256, base64url), e.g. a per-user token.
     *
     * @param purpose - what the digest is for
     * @param value - the input
     */
    public digest(purpose: string, value: string): string {
        return createHmac("sha256", this.key).update(`${purpose}\n${value}`, "utf8").digest("base64url");
    }
}
