import type { AiProviderKind } from "../types";
import { normalizeAiProviderKind } from "./ai";
import type { UiStrings } from "./uiStrings";

const providerModelSettingKeys: Record<AiProviderKind, string> = {
  "codex-cli": "codexModel",
  "claude-code": "claudeModel",
  "local-draft": "aiModel",
};

export const providerModelOptions: Record<AiProviderKind, Array<{ value: string; label: string }>> = {
  "codex-cli": [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ],
  "claude-code": [
    { value: "sonnet", label: "Claude Sonnet" },
    { value: "opus", label: "Claude Opus" },
    { value: "haiku", label: "Claude Haiku" },
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
  ],
  "local-draft": [],
};

export const codexReasoningEffortOptions = [
  { value: "", label: "CLI default" },
  { value: "none", label: "none" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
];

export function providerDisplayName(provider: string | null | undefined) {
  switch (normalizeAiProviderKind(provider)) {
    case "claude-code":
      return "Claude Code";
    case "local-draft":
      return "Local draft";
    case "codex-cli":
    default:
      return "Codex CLI";
  }
}

export function providerModelSettingKey(provider: string | null | undefined) {
  return providerModelSettingKeys[normalizeAiProviderKind(provider)];
}

export function aiModelForProvider(settings: Record<string, string>, provider: string | null | undefined) {
  const kind = normalizeAiProviderKind(provider);
  if (kind === "local-draft") {
    return "";
  }
  return settings[providerModelSettingKeys[kind]] || (kind === normalizeAiProviderKind(settings.aiProvider) ? settings.aiModel || "" : "");
}

export function selectedAiModel(settings: Record<string, string>) {
  return aiModelForProvider(settings, settings.aiProvider);
}

export function isKnownUnsupportedCodexModel(model: string | null | undefined) {
  const value = (model ?? "").trim().toLowerCase();
  return Boolean(value) && !providerModelOptions["codex-cli"].some((option) => option.value === value);
}

export function selectedAiModelForRun(settings: Record<string, string>) {
  const model = selectedAiModel(settings);
  return normalizeAiProviderKind(settings.aiProvider) === "codex-cli" && isKnownUnsupportedCodexModel(model) ? "" : model;
}

export function selectedCodexReasoningEffort(settings: Record<string, string>) {
  const value = (settings.codexReasoningEffort || "").trim().toLowerCase();
  return codexReasoningEffortOptions.some((option) => option.value === value) ? value : "";
}

export function aiRuntimeLabel(settings: Record<string, string>, ui: UiStrings) {
  const selectedModel = selectedAiModel(settings);
  const model =
    normalizeAiProviderKind(settings.aiProvider) === "codex-cli" && isKnownUnsupportedCodexModel(selectedModel)
      ? ui.providerDefault
      : selectedModel || ui.providerDefault;
  const effort = normalizeAiProviderKind(settings.aiProvider) === "codex-cli" ? selectedCodexReasoningEffort(settings) : "";
  return effort ? `${providerDisplayName(settings.aiProvider)} / ${model} / ${effort}` : `${providerDisplayName(settings.aiProvider)} / ${model}`;
}
