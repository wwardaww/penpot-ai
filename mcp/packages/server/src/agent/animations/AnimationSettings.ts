/** What {@link AnimationSettings} needs of a project workspace. */
export interface ProjectJsonStore {
    readJson<T>(name: string, fallback: T): Promise<T>;
    writeJson(name: string, value: unknown): Promise<void>;
}

/**
 * The project setting "AI may add animations" (W32): key `aiAnimations` of
 * `.penforge/project.json`, on unless it is `false`.
 *
 * Chat and generate-screen turns get a short system prompt note with its value; the prompts'
 * "Animation" sections say what Claude may do on its own initiative with it on or off. Animations
 * the user asks for are always allowed.
 */
export class AnimationSettings {
    /** Key in `project.json`. */
    public static readonly KEY = "aiAnimations";

    /** Workflows whose turns get the note. */
    public static readonly WORKFLOWS: readonly string[] = ["chat", "generate-screen"];

    private static readonly FILE = "project.json";

    /**
     * Reads the setting; on when the file or the key is missing or unreadable.
     *
     * @param store - the project workspace
     */
    public static async isOn(store: ProjectJsonStore): Promise<boolean> {
        try {
            const info = await store.readJson<Record<string, unknown> | null>(AnimationSettings.FILE, null);
            return info?.[AnimationSettings.KEY] !== false;
        } catch {
            return true;
        }
    }

    /**
     * Stores the setting, keeping the other keys of `project.json`.
     *
     * @param store - the project workspace
     * @param on - the new value
     */
    public static async set(store: ProjectJsonStore, on: boolean): Promise<boolean> {
        const info = (await store.readJson<Record<string, unknown> | null>(AnimationSettings.FILE, null)) ?? {};
        await store.writeJson(AnimationSettings.FILE, { ...info, [AnimationSettings.KEY]: on });
        return on;
    }

    /**
     * System prompt note for a turn of `workflow`, or undefined when that workflow gets none.
     *
     * @param store - the project workspace
     * @param workflow - the workflow of the turn
     */
    public static async promptNote(store: ProjectJsonStore, workflow: string | undefined): Promise<string | undefined> {
        if (workflow === undefined || !AnimationSettings.WORKFLOWS.includes(workflow)) {
            return undefined;
        }
        return AnimationSettings.note(await AnimationSettings.isOn(store));
    }

    /**
     * The note for a value of the setting.
     *
     * @param on - the setting
     */
    public static note(on: boolean): string {
        return on
            ? "## Animation initiative\nOn: you may add a few subtle animations on your own where they clearly " +
                  'help (see "Animation"), and you list them in your answer.'
            : "## Animation initiative\nOff: the user turned off animations added on your own initiative. Add, " +
                  "change or remove animations only when the user asks for them in this conversation.";
    }
}
