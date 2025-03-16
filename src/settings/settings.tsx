import * as React from "react";
import { Completer, Model } from "../complete/complete";
import { available } from "../complete/completers";
import { useState, useEffect } from "react";
import Companion, { AcceptSettings } from "../main";
import SettingsItem from "../components/SettingsItem";

// --- Presets Component (for Autocompleter only) ---
function Presets({
  plugin,
  setModel,
  setProvider,
  reload_signal,
}: {
  plugin: Companion;
  setModel: (model: string) => void;
  setProvider: (provider: string) => void;
  reload_signal: { reload: boolean };
}) {
  const [name, setName] = useState("");
  const [force_update, setForceUpdate] = useState(0);

  const savePreset = () => {
    if (!name) return;
    plugin.savePreset(name);
    setName("");
  };

  return (
    <>
      <SettingsItem
        name="Presets"
        description="Quickly switch between different settings."
      />
      {plugin.settings.presets.map((preset) => (
        <SettingsItem key={preset.name} name={preset.name}>
          <div
            className={
              "checkbox-container" +
              (preset.enable_editor_command ? " is-enabled" : "")
            }
            onClick={() => {
              preset.enable_editor_command = !preset.enable_editor_command;
              plugin.saveSettings();
              setForceUpdate(force_update + 1);
              reload_signal.reload = true;
            }}
          />
          Command
          <button
            onClick={() => {
              plugin.loadPreset(preset.name);
              setProvider(preset.provider);
              setModel(preset.model);
            }}
          >
            Load
          </button>
          <button
            onClick={() => {
              plugin.deletePreset(preset.name);
              setForceUpdate(force_update + 1);
            }}
          >
            Delete
          </button>
        </SettingsItem>
      ))}
      <SettingsItem
        name="Save preset"
        description="Save the current settings as a preset"
      >
        <input
          type="text"
          placeholder="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button onClick={savePreset}>Save preset</button>
      </SettingsItem>
      {plugin.settings.presets.length ? (
        <SettingsItem
          name="Fallback"
          description={
            <>
              Use a preset as the fallback if the current model is unavailable
              (e.g., when rate-limited).
            </>
          }
        >
          <select
            className="dropdown"
            value={plugin.settings.fallback || ""}
            aria-label="Fallback preset"
            onChange={(e) => {
              plugin.settings.fallback = e.target.value;
              plugin.saveSettings();
              setForceUpdate(force_update + 1);
            }}
          >
            <option value="">Don't use a fallback</option>
            {plugin.settings.presets.map((preset) => (
              <option key={preset.name} value={preset.name}>{preset.name}</option>
            ))}
          </select>
        </SettingsItem>
      ) : null}
    </>
  );
}

// --- Provider and Model Chooser (Reusable for both Chatbot and Autocompleter) ---
function ProviderModelChooser({
  plugin,
  reload_signal,
  scope, // "chatbot" or "autocompleter"
}: {
  plugin: Companion;
  reload_signal: { reload: boolean };
  scope: "chatbot" | "autocompleter";
}) {
  const [provider, setProvider] = useState<null | Completer>(null);
  const [providerSettings, setProviderSettings] = useState<null | string>(null);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [model, setModel] = useState<null | Model>(null);
  const [modelSettings, setModelSettings] = useState<null | string>(null);

  // Use the correct settings based on scope
  const getSettings = () => {
    if (scope === "chatbot") {
      return plugin.settings.chatbot;
    } else {
      return plugin.settings.autocompleter;
    }
  };

  const providerKey = getSettings().provider;
  const modelKey = getSettings().model;

  useEffect(() => {
    const candidates = available.filter((p) => p.id === providerKey);
    setProvider(candidates.length > 0 ? candidates[0] : available[0]);
    
    // Initialize provider settings
    const scopeSettings = getSettings();
    if (scopeSettings.provider_settings && scopeSettings.provider_settings[providerKey]) {
      setProviderSettings(scopeSettings.provider_settings[providerKey].settings);
    } else {
      // Initialize provider settings if they don't exist
      if (!scopeSettings.provider_settings) {
        scopeSettings.provider_settings = {};
      }
      if (!scopeSettings.provider_settings[providerKey]) {
        scopeSettings.provider_settings[providerKey] = {
          settings: "",
          models: {}
        };
      }
      setProviderSettings(scopeSettings.provider_settings[providerKey].settings);
    }
  }, [providerKey]);

  useEffect(() => {
    const fetchModels = async () => {
      if (!provider) return;
      
      setAvailableModels([]);
      setModel(null);
      
      const scopeSettings = getSettings();
      
      try {
        // Get models from the provider
        const models = await provider.get_models(
          scopeSettings.provider_settings && 
          scopeSettings.provider_settings[provider.id] ? 
          scopeSettings.provider_settings[provider.id].settings : ""
        );
        
        setAvailableModels(models);
        
        // Select the appropriate model
        const candidates = models.filter((m) => m.id === modelKey);
        const selectedModel = candidates.length > 0 ? candidates[0] : models[0];
        
        setModel(selectedModel);
        
        // Update model in settings if needed
        if (selectedModel) {
          scopeSettings.model = selectedModel.id;
          
          // Initialize model settings if they don't exist
          if (!scopeSettings.provider_settings[provider.id].models) {
            scopeSettings.provider_settings[provider.id].models = {};
          }
          
          // Get model settings
          const modelSettingsValue = 
            scopeSettings.provider_settings[provider.id].models[selectedModel.id] || "";
          
          setModelSettings(modelSettingsValue);
        }
        
        plugin.saveSettings();
      } catch (error) {
        console.error("Error fetching models:", error);
      }
    };
    
    fetchModels();
  }, [modelKey, provider, providerSettings]);

  const updateProvider = (providerId: string) => {
    const selectedProvider = available.filter((p) => p.id === providerId)[0];
    setProvider(selectedProvider);
    
    const scopeSettings = getSettings();
    
    // Initialize provider settings if they don't exist
    if (!scopeSettings.provider_settings) {
      scopeSettings.provider_settings = {};
    }
    
    if (!scopeSettings.provider_settings[providerId]) {
      scopeSettings.provider_settings[providerId] = {
        settings: "",
        models: {}
      };
    }
    
    setProviderSettings(scopeSettings.provider_settings[providerId].settings);
    scopeSettings.provider = providerId;
    
    plugin.saveSettings();
    if (scope === "chatbot") {
      // Trigger event for chat view update
      plugin.app.workspace.trigger("companion:settings-changed");
    }
    reload_signal.reload = true;
  };

  const updateProviderSettings = (settings: string) => {
    if (!provider) return;
    
    setProviderSettings(settings);
    
    const scopeSettings = getSettings();
    
    // Initialize provider settings if they don't exist
    if (!scopeSettings.provider_settings) {
      scopeSettings.provider_settings = {};
    }
    
    if (!scopeSettings.provider_settings[provider.id]) {
      scopeSettings.provider_settings[provider.id] = {
        settings: "",
        models: {}
      };
    }
    
    scopeSettings.provider_settings[provider.id].settings = settings;
    
    // If this is for the chatbot and provider settings contain an API key, sync it to the chatbot API key field
    if (scope === "chatbot") {
      try {
        // Parse settings to extract API key
        const parsedSettings = JSON.parse(settings);
        if (parsedSettings.api_key) {
          // Sync with main chatbot API key
          plugin.settings.chatbot.apiKey = parsedSettings.api_key;
        }
      } catch (e) {
        console.error("Error parsing provider settings:", e);
      }
    }
    
    plugin.saveSettings();
    reload_signal.reload = true;
  };

  const updateModel = (modelId: string) => {
    if (!provider) return;
    
    const selectedModel = availableModels.filter((m) => m.id === modelId)[0];
    setModel(selectedModel);
    
    const scopeSettings = getSettings();
    scopeSettings.model = modelId;
    
    // Initialize model settings if they don't exist
    if (!scopeSettings.provider_settings) {
      scopeSettings.provider_settings = {};
    }
    
    if (!scopeSettings.provider_settings[provider.id]) {
      scopeSettings.provider_settings[provider.id] = {
        settings: providerSettings || "",
        models: {}
      };
    }
    
    if (!scopeSettings.provider_settings[provider.id].models) {
      scopeSettings.provider_settings[provider.id].models = {};
    }
    
    const modelSettingsValue = 
      scopeSettings.provider_settings[provider.id].models[modelId] || "";
    
    setModelSettings(modelSettingsValue);
    
    plugin.saveSettings();
    if (scope === "chatbot") {
      // Trigger event for chat view update
      plugin.app.workspace.trigger("companion:settings-changed");
    }
    reload_signal.reload = true;
  };

  const updateModelSettings = (settings: string) => {
    if (!provider || !model) return;
    
    setModelSettings(settings);
    
    const scopeSettings = getSettings();
    
    // Initialize provider and model settings if they don't exist
    if (!scopeSettings.provider_settings) {
      scopeSettings.provider_settings = {};
    }
    
    if (!scopeSettings.provider_settings[provider.id]) {
      scopeSettings.provider_settings[provider.id] = {
        settings: providerSettings || "",
        models: {}
      };
    }
    
    if (!scopeSettings.provider_settings[provider.id].models) {
      scopeSettings.provider_settings[provider.id].models = {};
    }
    
    scopeSettings.provider_settings[provider.id].models[model.id] = settings;
    
    plugin.saveSettings();
    if (scope === "chatbot") {
      // Trigger event for chat view update
      plugin.app.workspace.trigger("companion:settings-changed");
    }
    reload_signal.reload = true;
  };

  const ProviderSettings = provider?.Settings;
  const ModelSettings = model?.Settings;

  return (
    <>
      <SettingsItem
        name="Provider"
        description={provider ? provider.description : ""}
      >
        <select
          className="dropdown"
          value={provider ? provider.id : ""}
          aria-label="Provider selection"
          onChange={(e) => updateProvider(e.target.value)}
        >
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </SettingsItem>
      {ProviderSettings && (
        <ProviderSettings settings={providerSettings} saveSettings={updateProviderSettings} />
      )}
      <SettingsItem
        name="Model"
        description={model ? model.description : ""}
      >
        <select
          className="dropdown"
          value={model ? model.id : ""}
          aria-label="Model selection"
          onChange={(e) => updateModel(e.target.value)}
        >
          {provider &&
            availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
      </SettingsItem>
      {ModelSettings && (
        <ModelSettings settings={modelSettings} saveSettings={updateModelSettings} />
      )}
      {scope === "autocompleter" && (
        <Presets
          plugin={plugin}
          setModel={updateModel}
          setProvider={updateProvider}
          reload_signal={reload_signal}
        />
      )}
    </>
  );
}

// --- Chatbot-Specific Settings ---
function ChatbotSettings({
  plugin,
  reload_signal,
}: {
  plugin: Companion;
  reload_signal: { reload: boolean };
}) {
  return (
    <>
      <h3>Chatbot Settings</h3>
      <ProviderModelChooser plugin={plugin} reload_signal={reload_signal} scope="chatbot" />
    </>
  );
}

// --- Autocompleter-Specific Settings ---
function AutocompleterSettings({
  plugin,
  reload_signal,
}: {
  plugin: Companion;
  reload_signal: { reload: boolean };
}) {
  const [enableByDefault, setEnableByDefault] = useState(
    plugin.settings.enable_by_default
  );
  const [streamingMode, setStreamingMode] = useState(plugin.settings.stream);
  const [acceptSettings, setAcceptSettings] = useState(plugin.settings.accept);
  const [delay, setDelay] = useState(plugin.settings.delay_ms);
  const [keybind, setKeybind] = useState(plugin.settings.keybind);
  const [expanded, setExpanded] = useState(false);

  const updateEnableByDefault = (value: boolean) => {
    setEnableByDefault(value);
    plugin.settings.enable_by_default = value;
    plugin.saveSettings();
  };

  const updateStreamingMode = (value: boolean) => {
    setStreamingMode(value);
    plugin.settings.stream = value;
    plugin.saveSettings();
  };

  const updateAcceptSettings = (settings: AcceptSettings) => {
    setAcceptSettings(settings);
    plugin.settings.accept = settings;
    for (const model of plugin.models) {
      model.cacher.accept_settings = settings;
    }
    plugin.saveSettings();
  };

  const updateDelay = (value: number) => {
    setDelay(value);
    plugin.settings.delay_ms = value;
    plugin.saveSettings();
    reload_signal.reload = true;
  };

  const updateKeybind = (value: string | null) => {
    setKeybind(value);
    plugin.settings.keybind = value;
    plugin.saveSettings();
    reload_signal.reload = true;
  };

  return (
    <>
      <h3>Autocompleter Settings</h3>
      <SettingsItem
        name="Enable by default"
        description={
          <>
            If not enabled by default, use Ctrl+P and search for "Toggle Completion" or add a shortcut.
          </>
        }
      >
        <div
          className={"checkbox-container" + (enableByDefault ? " is-enabled" : "")}
          onClick={() => updateEnableByDefault(!enableByDefault)}
        />
      </SettingsItem>
      <SettingsItem
        name="Streaming mode (experimental)"
        description={
          <>
            Updates completions as they come in, rather than waiting for the full result. Useful for slow completions but may be buggy.
          </>
        }
      >
        <div
          className={"checkbox-container" + (streamingMode ? " is-enabled" : "")}
          onClick={() => updateStreamingMode(!streamingMode)}
        />
      </SettingsItem>
      <SettingsItem
        name="Delay"
        description={
          <>
            Time to wait before fetching a completion. Lower delay = faster completions, higher cost.
          </>
        }
      >
        <input
          type="number"
          value={delay}
          aria-label="Delay in milliseconds"
          onChange={(e) => updateDelay(parseInt(e.target.value))}
        />
        <span>ms</span>
      </SettingsItem>
      <SettingsItem
        name="Use a CodeMirror Keybind"
        description={
          <>
            Enables simpler keybinds like <code>Tab</code>, but may conflict with other plugins.
          </>
        }
      >
        <div
          className={"checkbox-container" + (keybind !== null ? " is-enabled" : "")}
          onClick={() => updateKeybind(keybind === null ? "Tab" : null)}
        />
      </SettingsItem>
      {keybind !== null && (
        <SettingsItem
          name="CodeMirror Keybind"
          description={
            <>
              <a href="https://codemirror.net/docs/ref/#h_key_bindings">Keybind format</a>
            </>
          }
        >
          <input
            type="text"
            value={keybind || ""}
            aria-label="CodeMirror keybind"
            onChange={(e) => updateKeybind(e.target.value)}
          />
        </SettingsItem>
      )}
      <SettingsItem
        name="Accept"
        description={
          <div style={{ minWidth: "max-content" }}>
            <div>Presets for completion acceptance.</div>
            <div onClick={() => setExpanded(!expanded)}>
              {expanded ? "▾" : "▸"} Advanced controls
            </div>
          </div>
        }
      >
        <div className="ai-complete-accept-presets">
          <button
            onClick={() =>
              updateAcceptSettings({
                splitter_regex: " ",
                display_splitter_regex: "[.?!:;]",
                completion_completeness_regex: ".*(?!p{L})[^d]$",
                min_accept_length: 4,
                min_display_length: 50,
                retrigger_threshold: 48,
              })
            }
          >
            One word at a time
          </button>
          <button
            onClick={() =>
              updateAcceptSettings({
                splitter_regex: "\\.",
                display_splitter_regex: "[.?!:;]",
                completion_completeness_regex: ".*[^d]$",
                min_accept_length: 4,
                min_display_length: 50,
                retrigger_threshold: 128,
              })
            }
          >
            One sentence at a time
          </button>
          <button
            onClick={() =>
              updateAcceptSettings({
                splitter_regex: "\n",
                display_splitter_regex: "\n",
                completion_completeness_regex: ".*$",
                min_accept_length: 4,
                min_display_length: 50,
                retrigger_threshold: 128,
              })
            }
          >
            One line at a time
          </button>
          <button
            onClick={() =>
              updateAcceptSettings({
                splitter_regex: "$",
                display_splitter_regex: "$",
                completion_completeness_regex: ".*",
                min_accept_length: 0,
                min_display_length: 0,
                retrigger_threshold: 128,
              })
            }
          >
            Whole completion
          </button>
        </div>
      </SettingsItem>
      {expanded && (
        <div className="ai-complete-advanced-settings">
          <SettingsItem
            name="Splitter regex"
            description="Splits completion chunks; only one chunk is accepted at a time."
          >
            <input
              type="text"
              value={acceptSettings.splitter_regex}
              aria-label="Splitter regex"
              onChange={(e) =>
                updateAcceptSettings({ ...acceptSettings, splitter_regex: e.target.value })
              }
            />
          </SettingsItem>
          <SettingsItem
            name="Preview splitter regex"
            description="Splits preview chunks; only one chunk is displayed at a time."
          >
            <input
              type="text"
              value={acceptSettings.display_splitter_regex}
              aria-label="Preview splitter regex"
              onChange={(e) =>
                updateAcceptSettings({
                  ...acceptSettings,
                  display_splitter_regex: e.target.value,
                })
              }
            />
          </SettingsItem>
          <SettingsItem
            name="Completion completeness regex"
            description="If unmatched, the last chunk (per preview splitter) is discarded."
          >
            <input
              type="text"
              value={acceptSettings.completion_completeness_regex}
              aria-label="Completion completeness regex"
              onChange={(e) =>
                updateAcceptSettings({
                  ...acceptSettings,
                  completion_completeness_regex: e.target.value,
                })
              }
            />
          </SettingsItem>
          <SettingsItem
            name="Minimum completion length"
            description="Completes the fewest chunks exceeding this length."
          >
            <input
              type="number"
              value={acceptSettings.min_accept_length}
              aria-label="Minimum completion length"
              onChange={(e) =>
                updateAcceptSettings({
                  ...acceptSettings,
                  min_accept_length: parseInt(e.target.value),
                })
              }
            />
          </SettingsItem>
          <SettingsItem
            name="Minimum display length"
            description="Displays the fewest preview chunks exceeding this length."
          >
            <input
              type="number"
              value={acceptSettings.min_display_length}
              aria-label="Minimum display length"
              onChange={(e) =>
                updateAcceptSettings({
                  ...acceptSettings,
                  min_display_length: parseInt(e.target.value),
                })
              }
            />
          </SettingsItem>
          <SettingsItem
            name="Retrigger threshold"
            description="Triggers a new API call when this many characters remain."
          >
            <input
              type="number"
              value={acceptSettings.retrigger_threshold}
              aria-label="Retrigger threshold"
              onChange={(e) =>
                updateAcceptSettings({
                  ...acceptSettings,
                  retrigger_threshold: parseInt(e.target.value),
                })
              }
            />
          </SettingsItem>
        </div>
      )}
      <ProviderModelChooser
        plugin={plugin}
        reload_signal={reload_signal}
        scope="autocompleter"
      />
    </>
  );
}

// --- Main Settings Component ---
export default function SettingsComponent({
  plugin,
  reload_signal,
}: {
  plugin: Companion;
  reload_signal: { reload: boolean };
}) {
  return (
    <>
      <ChatbotSettings plugin={plugin} reload_signal={reload_signal} />
      <AutocompleterSettings plugin={plugin} reload_signal={reload_signal} />
    </>
  );
}