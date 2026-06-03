import { useEffect } from "react";
import type { AgentProviderStatus, AiProviderKind, AppStateRecord } from "../types";
import { normalizeAiProviderKind } from "../lib/ai";
import { selectedAiModel, selectedCodexReasoningEffort, isKnownUnsupportedCodexModel } from "../lib/aiPreferences";
import { initialState, wordMeaningLookupEnabled } from "../lib/appState";
import { isUnsafeGeneratedHref } from "../lib/linkPreviews";
import { getAgentProviderStatus, loadAppState, setSetting } from "../lib/tauri";
import { translationLanguageOption } from "../lib/uiStrings";

type AppStartupInput = {
  setState: (state: AppStateRecord) => void;
  setActiveDocumentId: (id: string | null) => void;
  setAgentStatuses: (statuses: Partial<Record<AiProviderKind, AgentProviderStatus>>) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
};

export function useAppStartup(input: AppStartupInput) {
  const { setState, setActiveDocumentId, setAgentStatuses, showToast } = input;
  useEffect(() => {
    const blockUnsafeGeneratedNavigation = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link) {
        return;
      }
      if (isUnsafeGeneratedHref(link.getAttribute("href")) || isUnsafeGeneratedHref(link.href)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", blockUnsafeGeneratedNavigation, true);
    return () => document.removeEventListener("click", blockUnsafeGeneratedNavigation, true);
  }, []);

  useEffect(() => {
    let mounted = true;
    loadAppState()
      .then((loaded) => {
        if (!mounted) {
          return;
        }
        const settings = { ...initialState.settings, ...loaded.settings };
        settings.uiLanguage = settings.uiLanguage === "en" ? "en" : "ko";
        settings.language = settings.uiLanguage;
        settings.translationLanguage = translationLanguageOption(settings.translationLanguage).value;
        const normalizedProvider = normalizeAiProviderKind(settings.aiProvider);
        settings.codexModel = settings.codexModel || (normalizedProvider === "codex-cli" ? settings.aiModel || "" : "");
        if (isKnownUnsupportedCodexModel(settings.codexModel)) {
          settings.codexModel = "";
          if (normalizedProvider === "codex-cli") {
            settings.aiModel = "";
          }
          void setSetting("codexModel", "").catch((error) => showToast(String(error), "error"));
        }
        settings.codexReasoningEffort = selectedCodexReasoningEffort(settings);
        settings.claudeModel = settings.claudeModel || (normalizedProvider === "claude-code" ? settings.aiModel || "" : "");
        settings.autoHighlight = "false";
        settings.wordMeaningLookupEnabled = wordMeaningLookupEnabled(settings) ? "true" : "false";
        settings.aiModel = selectedAiModel(settings);
        if (settings.aiProvider !== normalizedProvider) {
          settings.aiProvider = normalizedProvider;
          void setSetting("aiProvider", normalizedProvider).catch((error) => showToast(String(error), "error"));
        }
        if (loaded.settings.autoTranslateAutostartMigrated !== "true") {
          settings.autoTranslate = "true";
          settings.autoTranslateAutostartMigrated = "true";
          void setSetting("autoTranslate", "true").catch((error) => showToast(String(error), "error"));
          void setSetting("autoTranslateAutostartMigrated", "true").catch((error) => showToast(String(error), "error"));
        }
        setState({ ...initialState, ...loaded, settings });
        if (loaded.documents.length > 0) {
          setActiveDocumentId(loaded.documents[0].id);
        }
      })
      .catch((error) => showToast(String(error), "error"));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const providers: AiProviderKind[] = ["codex-cli", "claude-code", "local-draft"];
    Promise.all(providers.map(async (provider) => [provider, await getAgentProviderStatus(provider)] as const))
      .then((entries) => {
        if (!cancelled) {
          setAgentStatuses(Object.fromEntries(entries) as Partial<Record<AiProviderKind, AgentProviderStatus>>);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentStatuses({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

}
