import type { Workflow } from "@penpot/mcp-common";
import * as shippedWorkflows from "./index";

/**
 * Registry of daemon workflows, keyed by name.
 *
 * Append-only: a name can be registered once, and `answer` is reserved for the built-in that
 * answers workflow questions.
 */
export class WorkflowRegistry {
    /** Name of the built-in workflow that answers a pending question. */
    public static readonly ANSWER = "answer";

    private static readonly NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
    private readonly workflows = new Map<string, Workflow<any>>();

    /**
     * Creates a registry holding the workflows exported by `workflows/index.ts`.
     */
    public static withShippedWorkflows(): WorkflowRegistry {
        const registry = new WorkflowRegistry();
        for (const workflow of Object.values(shippedWorkflows) as Workflow<any>[]) {
            registry.register(workflow);
        }
        return registry;
    }

    /**
     * Registers a workflow.
     *
     * @param workflow - the workflow
     * @throws Error if the name is invalid, reserved or taken
     */
    public register(workflow: Workflow<any>): void {
        if (!WorkflowRegistry.NAME_PATTERN.test(workflow.name)) {
            throw new Error(`Invalid workflow name ${JSON.stringify(workflow.name)}`);
        }
        if (workflow.name === WorkflowRegistry.ANSWER) {
            throw new Error(`Workflow name "${WorkflowRegistry.ANSWER}" is reserved`);
        }
        if (this.workflows.has(workflow.name)) {
            throw new Error(`Workflow "${workflow.name}" is already registered`);
        }
        this.workflows.set(workflow.name, workflow);
    }

    /**
     * Gets a workflow.
     *
     * @param name - the workflow name
     */
    public get(name: string): Workflow<any> | undefined {
        return this.workflows.get(name);
    }

    /** Gets the names of all workflows. */
    public names(): string[] {
        return [...this.workflows.keys()];
    }
}
