import { Bot, Trash2 } from "../icons";
import type { AgentProviderStatus, AiProviderKind } from "../../types";
import { normalizeAiProviderKind } from "../../lib/ai";
import { aiModelForProvider, codexReasoningEffortOptions, isKnownUnsupportedCodexModel, providerModelOptions, providerModelSettingKey, selectedCodexReasoningEffort } from "../../lib/aiPreferences";
import { translationLanguageOption, translationLanguageOptions, uiLanguageFromSettings, type UiLanguage, type UiStrings } from "../../lib/uiStrings";
export function SettingsView(props: {
  ui: UiStrings;
  uiLanguage: UiLanguage;
  settings: Record<string, string>;
  agentStatuses: Partial<Record<AiProviderKind, AgentProviderStatus>>;
  runtime: string;
  onChange: (key: string, value: string) => void;
  onResetWorkspace: () => void;
}) {
  const provider = normalizeAiProviderKind(props.settings.aiProvider);
  const providerStatus = props.agentStatuses[provider];
  const claudeMissing = props.agentStatuses["claude-code"]?.installed === false;
  const providerStatusLabel =
    providerStatus?.installed === true ? props.ui.installed : providerStatus?.installed === false ? props.ui.notInstalled : props.ui.unknown;
  const providerStatusMessage = providerStatus?.installed === null ? props.ui.browserPreviewStatus : providerStatus?.message;
  const selectedModel = aiModelForProvider(props.settings, provider);
  const modelOptions = providerModelOptions[provider];
  const selectedModelIsKnown = modelOptions.some((option) => option.value === selectedModel);
  const setSelectedModel = (value: string) => {
    const safeValue = provider === "codex-cli" && isKnownUnsupportedCodexModel(value) ? "" : value;
    props.onChange(providerModelSettingKey(provider), safeValue);
    props.onChange("aiModel", safeValue);
  };
  return (
    <section className="settings-view">
      <div className="settings-header">
        <div>
          <h2>{props.ui.settingsTitle}</h2>
          <p>{props.ui.settingsSubtitle}</p>
        </div>
      </div>
      <div className="settings-grid">
        <label className="field">
          <span>{props.ui.uiLanguage}</span>
          <select
            value={uiLanguageFromSettings(props.settings)}
            onChange={(event) => {
              props.onChange("uiLanguage", event.target.value);
              props.onChange("language", event.target.value);
            }}
          >
            <option value="ko">Korean</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">
          <span>{props.ui.translationLanguage}</span>
          <select
            value={translationLanguageOption(props.settings.translationLanguage).value}
            onChange={(event) => props.onChange("translationLanguage", event.target.value)}
          >
            {translationLanguageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {props.uiLanguage === "ko" ? option.ko : option.en}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{props.ui.theme}</span>
          <select value={props.settings.theme} onChange={(event) => props.onChange("theme", event.target.value)}>
            <option value="light">Light</option>
            <option value="ink">Ink</option>
          </select>
        </label>
        <label className="field">
          <span>{props.ui.fontSize}</span>
          <input
            type="range"
            min="0.9"
            max="1.2"
            step="0.05"
            value={props.settings.fontScale}
            onChange={(event) => props.onChange("fontScale", event.target.value)}
          />
        </label>
        <label className="field">
          <span>{props.ui.mathDelimiter}</span>
          <input value={props.settings.mathDelimiter} onChange={(event) => props.onChange("mathDelimiter", event.target.value)} />
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={props.settings.autoTranslate === "true"}
            onChange={(event) => props.onChange("autoTranslate", String(event.target.checked))}
          />
          <span>{props.ui.autoTranslate}</span>
        </label>
        <label className="field">
          <span>{props.ui.aiProvider}</span>
          <select
            value={provider}
            onChange={(event) => {
              const nextProvider = normalizeAiProviderKind(event.target.value);
              props.onChange("aiProvider", nextProvider);
              props.onChange("aiModel", aiModelForProvider(props.settings, nextProvider));
            }}
          >
            <option value="codex-cli">Codex CLI</option>
            <option value="claude-code">Claude Code{claudeMissing ? props.ui.claudeMissingSuffix : ""}</option>
            <option value="local-draft">Local draft</option>
          </select>
          {providerStatus && provider !== "local-draft" && (
            <p className={`provider-status ${providerStatus.installed === false ? "provider-status-error" : ""}`}>
              <strong>{providerStatusLabel}</strong>
              <span>
                {providerStatus.installed === true
                  ? providerStatus.source ?? providerStatus.command ?? providerStatusMessage
                  : providerStatus.installed === null
                    ? providerStatusMessage
                  : provider === "claude-code"
                    ? props.ui.claudeMissingHelp
                    : providerStatusMessage}
              </span>
            </p>
          )}
        </label>
        <label className="field model-field">
          <span>{props.ui.model}</span>
          <select
            value={selectedModelIsKnown ? selectedModel : ""}
            disabled={provider === "local-draft"}
            onChange={(event) => setSelectedModel(event.target.value)}
          >
            <option value="">{props.ui.providerDefault}</option>
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {provider === "codex-cli" && (
          <label className="field">
            <span>{props.ui.reasoningEffort || "Reasoning effort"}</span>
            <select
              value={selectedCodexReasoningEffort(props.settings)}
              onChange={(event) => {
                props.onChange("codexReasoningEffort", event.target.value);
              }}
            >
              {codexReasoningEffortOptions.map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{props.ui.bridgePath}</span>
          <input value={props.settings.bridgePath} onChange={(event) => props.onChange("bridgePath", event.target.value)} />
        </label>
        <label className="field wide-field">
          <span>{props.ui.customPrompt}</span>
          <textarea value={props.settings.customPrompt} onChange={(event) => props.onChange("customPrompt", event.target.value)} />
        </label>
      </div>
      <div className="runtime-card">
        <Bot size={20} />
        <div>
          <strong>{props.runtime}</strong>
          <span>{props.ui.runtimeHint}</span>
        </div>
      </div>
      <div className="danger-card">
        <Trash2 size={20} />
        <div>
          <strong>{props.ui.resetTitle}</strong>
          <span>{props.ui.resetDescription}</span>
        </div>
        <button onClick={props.onResetWorkspace}>{props.ui.resetAction}</button>
      </div>
    </section>
  );
}
