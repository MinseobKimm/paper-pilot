import type {
  AiProviderKind,
  AiResultRecord,
  AiTaskType,
  DocumentRecord,
} from "../types";
import { makeId, nowIso } from "./ids";
import { buildAiPrompt, bridgePayloadFor, inputTextFor, localAiOutput, providerLabel } from "./aiPrompt";
import { saveAiResult, writeBridgeTask } from "./tauri";

export type AiTask = {
  taskType: AiTaskType;
  document: DocumentRecord;
  payload: Record<string, unknown>;
};

export interface AiProvider {
  run(task: AiTask): Promise<AiResultRecord>;
}

export function normalizeAiProviderKind(kind: string | null | undefined): AiProviderKind {
  if (kind === "claude-code") {
    return "claude-code";
  }
  if (kind === "local-draft" || kind === "api-provider") {
    return "local-draft";
  }
  return "codex-cli";
}

export function isAgentProvider(kind: string | null | undefined): boolean {
  return normalizeAiProviderKind(kind) !== "local-draft";
}

export class AgentCliProvider implements AiProvider {
  constructor(
    private readonly bridgePath: string,
    private readonly provider: AiProviderKind,
  ) {}

  async run(task: AiTask): Promise<AiResultRecord> {
    const prompt = buildAiPrompt(task);
    const providerSessionId =
      typeof task.payload.providerSessionId === "string" ? task.payload.providerSessionId : undefined;
    const model = typeof task.payload.model === "string" ? task.payload.model : undefined;
    const reasoningEffort =
      typeof task.payload.reasoningEffort === "string" ? task.payload.reasoningEffort : undefined;
    const bridgePayload = bridgePayloadFor(task, prompt);
    const bridgeTask = await writeBridgeTask(
      this.bridgePath,
      task.taskType,
      task.document.id,
      this.provider,
      model,
      reasoningEffort,
      providerSessionId,
      bridgePayload,
    );
    const taskLocation = bridgeTask.filePath
      ? `\n\nAgent task: ${bridgeTask.filePath}`
      : `\n\nAgent task: ${this.bridgePath}/outbox/${bridgeTask.id}.json`;
    return saveAiResult({
      id: bridgeTask.id,
      documentId: task.document.id,
      taskType: task.taskType,
      inputText: inputTextFor(task.payload),
      outputText: `${localAiOutput(task)}${taskLocation}\nStatus: waiting for ${providerLabel(this.provider)}.`,
      status: "pending",
      createdAt: bridgeTask.createdAt,
      provider: this.provider,
      model,
      providerSessionId,
    });
  }
}

export class LocalDraftProvider implements AiProvider {
  async run(task: AiTask): Promise<AiResultRecord> {
    return saveAiResult({
      id: makeId("local"),
      documentId: task.document.id,
      taskType: task.taskType,
      inputText: inputTextFor(task.payload),
      outputText: localAiOutput(task),
      status: "complete",
      createdAt: nowIso(),
      provider: "local-draft",
    });
  }
}

export function providerFor(kind: AiProviderKind | string, bridgePath: string): AiProvider {
  const provider = normalizeAiProviderKind(kind);
  if (provider === "local-draft") {
    return new LocalDraftProvider();
  }
  return new AgentCliProvider(bridgePath, provider);
}

export async function runAiTask(
  providerKind: AiProviderKind | string,
  bridgePath: string,
  taskType: AiTaskType,
  document: DocumentRecord,
  payload: Record<string, unknown>,
): Promise<AiResultRecord> {
  return providerFor(providerKind, bridgePath).run({ taskType, document, payload });
}

export function makeLocalAiResult(
  documentId: string,
  taskType: AiTaskType,
  inputText: string,
  outputText: string,
  status: AiResultRecord["status"] = "complete",
): AiResultRecord {
  return {
    id: makeId("ai"),
    documentId,
    taskType,
    inputText,
    outputText,
    status,
    createdAt: nowIso(),
    provider: "local-draft",
  };
}
