/**
 * Allocator of unique, URL-safe screen routes (`/`, `/login`, `/order-details-2`, …).
 */
export class Routes {
    private static readonly VALID = /^\/[A-Za-z0-9/_:-]*$/;
    /** Latin letters that do not decompose into a base letter */
    private static readonly LETTERS: Record<string, string> = {
        ı: "i",
        ł: "l",
        đ: "d",
        ø: "o",
        ß: "ss",
        æ: "ae",
        œ: "oe",
    };
    private readonly taken = new Set<string>();

    /**
     * @param taken - routes already in use
     */
    constructor(taken: Iterable<string> = []) {
        for (const route of taken) {
            this.taken.add(route);
        }
    }

    /**
     * Claims a route: the wanted one when it is valid and free, else one derived from the name.
     *
     * @param wanted - proposed route, may be missing or invalid
     * @param name - screen name to derive a route from
     */
    public claim(wanted: string | undefined, name: string): string {
        const route = wanted?.trim();
        if (route !== undefined && Routes.VALID.test(route) && !this.taken.has(route)) {
            this.taken.add(route);
            return route;
        }
        return this.next(name);
    }

    /**
     * Claims a free route derived from a screen name.
     *
     * @param name - the screen name
     */
    public next(name: string): string {
        const slug =
            name
                .normalize("NFKD")
                .replace(/\p{Mn}/gu, "")
                .toLowerCase()
                .replace(/[ıłđøßæœ]/g, (letter) => Routes.LETTERS[letter] ?? "")
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "screen";
        let route = `/${slug}`;
        for (let index = 2; this.taken.has(route); index++) {
            route = `/${slug}-${index}`;
        }
        this.taken.add(route);
        return route;
    }

    /**
     * Tells whether a string is a valid route.
     *
     * @param route - the candidate
     */
    public static isValid(route: string): boolean {
        return Routes.VALID.test(route);
    }
}
