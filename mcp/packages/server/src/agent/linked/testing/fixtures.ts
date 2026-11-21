import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
    AgentContext,
    WorkflowClaudeRequest,
    WorkflowClaudeResult,
    WorkflowContext,
    WorkflowQuestion,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { ProjectWorkspace } from "../../workspace/ProjectWorkspace";
import type { ProjectLink } from "../ProjectLink";

/** Writes files below a folder (`{"a/b.txt": "text"}`). */
export function writeTree(root: string, files: Record<string, string | Buffer>): void {
    for (const [path, content] of Object.entries(files)) {
        const file = join(root, ...path.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
}

/** Big dependency-like folder: many files that must never be read. */
function bulk(prefix: string, count: number, content: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
        files[`${prefix}/file${i}.txt`] = content;
        files[`${prefix}/deep/nested/doc${i}.md`] = `# cache ${i}`;
        files[`${prefix}/script${i}.cs`] = "using UnityEngine.UI; class Cached {}";
    }
    return files;
}

/** Fake Unity project: GDD, UI Toolkit file, HUD controller, gameplay script, big `Library/`. */
export function unityGame(root: string, bulkCount = 40): void {
    writeTree(root, {
        "Assets/UI/Main.uxml": '<ui:UXML><ui:Button text="Play" /></ui:UXML>',
        "Assets/UI/Main.uss": ".play { color: #ffcc00; }",
        "Assets/UI/Prefabs/PauseMenu.prefab": "%YAML prefab bytes",
        "Assets/Scripts/HudController.cs":
            "using UnityEngine;\nusing UnityEngine.UI;\npublic class HudController : MonoBehaviour { public Slider health; }",
        "Assets/Scripts/EnemyAI.cs": "using UnityEngine;\npublic class EnemyAI : MonoBehaviour {}",
        "Docs/GDD.md":
            "# Star Miner GDD\n\n- Core loop: mine asteroids, upgrade the ship.\n- HUD shows hull and fuel.\n",
        "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 2022.3.10f1",
        "README.md": "# Star Miner",
        ...bulk("Library", bulkCount, "cache"),
        ...bulk("Temp", 5, "temp"),
    });
}

/** Fake Unreal Engine 5 project: `.uproject`, HUD source, gameplay source, UI widgets, big `Binaries/`. */
export function unrealGame(root: string): void {
    writeTree(root, {
        "Skyfall.uproject": '{"EngineAssociation": "5.3"}',
        "Source/Skyfall/SkyfallHUD.h": '#include "GameFramework/HUD.h"\nclass ASkyfallHUD : public AHUD {};',
        "Source/Skyfall/MainMenuWidget.cpp": '#include "Blueprint/UserWidget.h"',
        "Source/Skyfall/Weapon.cpp": "void AWeapon::Fire() {}",
        "Config/DefaultGame.ini": "[/Script/UMG]\nWidgetClass=/Game/UI/WBP_Main",
        "Config/DefaultInput.ini": "[/Script/Engine.InputSettings]\nbEnableMouseSmoothing=True",
        "Content/UI/WBP_Main.uasset": Buffer.from([0x9e, 0x2a, 0x83, 0xc1, 0, 1, 2]),
        "Content/Maps/Level1.umap": "map",
        "Content/Characters/Hero.uasset": Buffer.from([1, 2, 3]),
        "Docs/Design.md": "# Skyfall\n\nArcade flyer.",
        ...bulk("Binaries", 10, "bin"),
        ...bulk("Intermediate", 10, "obj"),
    });
}

/** Fake React web app: DESIGN.md, routes in `src/`, big `node_modules/`, a `.gitignore`. */
export function reactApp(root: string, bulkCount = 60): void {
    writeTree(root, {
        "package.json": JSON.stringify({
            name: "tasks",
            dependencies: { react: "18.3.1", "react-router-dom": "6.0.0" },
        }),
        "DESIGN.md": "---\nname: Tasks\n---\n\n# Tasks design\n\n## Colors\n- primary: #3355ff\n",
        "README.md": "# Tasks\n\nA to-do app.",
        ".gitignore": "secret/\n*.local\n",
        "src/App.tsx":
            'import { Route, Routes } from "react-router-dom";\nexport const App = () => (<Routes><Route path="/" element={<Home />} /><Route path="/settings" element={<Settings />} /></Routes>);',
        "src/pages/Home.tsx": 'export const Home = () => <main className="home">Tasks</main>;',
        "src/pages/Settings.tsx": "export const Settings = () => <main>Settings</main>;",
        "src/components/Card.tsx": 'export const Card = ({ title }) => <div className="card">{title}</div>;',
        "src/api/client.ts": "export async function listTasks() { return []; }",
        "src/styles.css": ":root { --primary: #3355ff; }\n.card { border-radius: 4px; }",
        "secret/keys.ts": "export const key = 'x';",
        "notes.local": "private",
        ...bulk("node_modules/react", bulkCount, "module.exports = {}"),
        ...bulk("dist", 5, "built"),
    });
}

/** Makes a folder a git repository with one commit on `main`. */
export function gitInit(root: string): void {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "initial");
}

/** Runs git in a folder and returns its output. */
export function git(root: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
}

/** A fake workflow context on a real project workspace. */
export interface FakeRun {
    ctx: WorkflowContext;
    events: Array<{ kind: string; payload: any }>;
    turns: WorkflowClaudeRequest[];
    questions: WorkflowQuestion[];
    calls: Array<{ name: string; args: any }>;
}

/**
 * Creates a project workspace linked to a folder and a workflow context on it.
 *
 * @param projectsDir - folder of the project folders
 * @param link - the link (null for none)
 * @param options - context type, Claude's turn, tool answers and question answers
 */
export async function fakeRun(
    projectsDir: string,
    link: ProjectLink | null,
    options: {
        projectType: AgentContext["projectType"];
        turn?: (request: WorkflowClaudeRequest) => Promise<WorkflowClaudeResult> | WorkflowClaudeResult;
        tool?: (name: string, args: any) => WorkflowToolResult;
        answers?: string[];
        projectId?: string;
    }
): Promise<FakeRun> {
    const workspace = new ProjectWorkspace(projectsDir, options.projectId ?? "project-1");
    await workspace.ensure();
    workspace.setLink(link);
    const events: FakeRun["events"] = [];
    const turns: WorkflowClaudeRequest[] = [];
    const questions: WorkflowQuestion[] = [];
    const calls: FakeRun["calls"] = [];
    const answers = [...(options.answers ?? [])];
    const ctx = {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "File",
            projectId: workspace.projectId,
            teamId: "team-1",
            pageId: "page-1",
            persona: "designer",
            platform: "web",
            projectType: options.projectType,
        },
        workspace,
        signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
        runner: {
            run: async (request: WorkflowClaudeRequest) => {
                turns.push(request);
                return options.turn ? options.turn(request) : { text: "" };
            },
        },
        tools: {
            call: async (name: string, args: any) => {
                calls.push({ name, args });
                return options.tool ? options.tool(name, args) : { isError: true, content: [], text: "no tools" };
            },
            list: async () => [],
        },
        emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
        ask: async (question: WorkflowQuestion) => {
            questions.push(question);
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error(`unexpected question: ${question.text}`);
            }
            return answer;
        },
    } as unknown as WorkflowContext;
    return { ctx, events, turns, questions, calls };
}

/** A tool result with JSON text. */
export function okJson(value: unknown): WorkflowToolResult {
    return { isError: false, content: [{ type: "text", text: JSON.stringify(value) }], text: JSON.stringify(value) };
}

/** A 1×1 PNG. */
export const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
);
