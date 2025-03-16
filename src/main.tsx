import {
	App,
	MarkdownView,
	FuzzySuggestModal,
	Notice,
	Plugin,
	PluginSettingTab,
	Editor,
} from "obsidian";
import { createRoot } from "react-dom/client";
import React from "react";
import {
	forceableInlineSuggestion,
	Suggestion,
} from "codemirror-companion-extension";
import SettingsComponent from "./settings/settings";
import { CompletionCacher } from "./cache";
import { available } from "./complete/completers";
import { Model } from "./complete/complete";
import { ChatSidebarView, CHAT_VIEW_TYPE } from "./chat/ChatSidebarView";

interface CompanionModelSettings {
	name: string;
	provider: string;
	model: string;
	provider_settings: string;
	model_settings: string;
	enable_editor_command: boolean;
}

export interface AcceptSettings {
	splitter_regex: string;
	display_splitter_regex: string;
	completion_completeness_regex: string;
	min_accept_length: number;
	min_display_length: number;
	retrigger_threshold: number;
}

interface CompanionSettings {
	provider: string;
	model: string;
	enable_by_default: boolean;
	keybind: string | null;
	delay_ms: number;
	stream: boolean;
	accept: AcceptSettings;
	provider_settings: {
		[provider: string]: {
			settings: string;
			models: {
				[model: string]: string;
			};
		};
	};
	presets: CompanionModelSettings[];
	fallback: string | null;
	
	// New settings for feature toggles
	enableChat: boolean;
	enableAutocomplete: boolean;
	
	// LLM selections for different features
	chatProvider: string;
	chatModel: string;
	autocompleteProvider: string;
	autocompleteModel: string;
	
	// Add new properties for chatbot and autocompleter
	chatbot: {
		provider: string;
		model: string;
		provider_settings: {
			[provider: string]: {
				settings: string;
				models: {
					[model: string]: string;
				};
			};
		};
		apiKey: string;
	};
	autocompleter: {
		provider: string;
		model: string;
		provider_settings: {
			[provider: string]: {
				settings: string;
				models: {
					[model: string]: string;
				};
			};
		};
	};
}

const DEFAULT_SETTINGS: CompanionSettings = {
	provider: "openai-chatgpt",
	model: "gpt3.5-turbo",
	enable_by_default: false,
	keybind: "Tab",
	delay_ms: 2000,
	stream: true,
	accept: {
		splitter_regex: " ",
		display_splitter_regex: "[.?!:;]",
		completion_completeness_regex: ".*(?!p{L})[^d]$",
		min_accept_length: 4,
		min_display_length: 50,
		retrigger_threshold: 48,
	},
	provider_settings: {},
	presets: [],
	fallback: null,
	
	// New settings for feature toggles
	enableChat: true,
	enableAutocomplete: true,
	
	// LLM selections for different features
	chatProvider: "openai-chatgpt",
	chatModel: "gpt3.5-turbo",
	autocompleteProvider: "openai-chatgpt",
	autocompleteModel: "gpt3.5-turbo",
	
	// Add new properties for chatbot and autocompleter
	chatbot: {
		provider: "openai-chatgpt",
		model: "gpt3.5-turbo",
		provider_settings: {},
		apiKey: "",
	},
	autocompleter: {
		provider: "openai-chatgpt",
		model: "gpt3.5-turbo",
		provider_settings: {},
	},
};

export default class Companion extends Plugin {
	settings: CompanionSettings;
	enabled: boolean = false;
	force_fetch: () => void = () => {};
	last_used_model: CompletionCacher | null = null;
	models: {
		provider: string;
		model: string;
		cacher: CompletionCacher;
	}[] = [];
	statusBarItemEl: HTMLElement | null = null;

	async setupModelChoice() {
		await this.loadSettings();
		this.enabled = this.settings.enable_by_default;

		this.addCommand({
			id: "load-preset",
			name: "Load preset",
			callback: () => {
				new PresetChooserModal(this).open();
			},
		});

		for (const preset of this.settings.presets) {
			if (!preset.enable_editor_command) continue;
			this.addCommand({
				id: `load-preset-${preset.name}`,
				name: `Load preset: ${preset.name}`,
				callback: () => {
					this.loadPreset(preset.name);
				},
			});
		}
	}

	async setupToggle() {
		this.enabled = this.settings.enable_by_default && this.settings.enableAutocomplete;
		this.addRibbonIcon(
			"terminal",
			"Toggle completion",
			(_evt: MouseEvent) => {
				this.enabled = !this.enabled;
				this.fillStatusbar();
				new Notice(
					`Completion is now ${this.enabled ? "enabled" : "disabled"}`
				);
			}
		);
		this.addCommand({
			id: "toggle",
			name: "Toggle completion",
			callback: () => {
				this.enabled = !this.enabled;
				this.fillStatusbar();
				new Notice(
					`Completion is now ${this.enabled ? "enabled" : "disabled"}`
				);
			},
		});
	}

	async setupSuggestions() {
		const { extension, force_fetch } = forceableInlineSuggestion({
			fetchFn: () => this.triggerCompletion(),
			delay: this.settings.delay_ms,
			continue_suggesting: true,
			accept_shortcut: this.settings.keybind,
		});
		this.force_fetch = force_fetch;
		this.registerEditorExtension(extension);
	}

	async setupStatusbar() {
		this.statusBarItemEl = this.addStatusBarItem();
		this.fillStatusbar();
	}

	async setupSuggestionCommands() {
		this.addCommand({
			id: "accept",
			name: "Accept completion",
			editorCallback: (editor: Editor) => this.acceptCompletion(editor),
		});
		this.addCommand({
			id: "suggest",
			name: "Generate completion",
			editorCallback: () => this.force_fetch(),
		});
	}

	async onload() {
		await this.loadSettings();

		if (this.settings.enableAutocomplete) {
			await this.setupModelChoice();
			await this.setupToggle();
			await this.setupSuggestions();
			await this.setupStatusbar();
			await this.setupSuggestionCommands();
		}

		if (this.settings.enableChat) {
			this.registerView(
				CHAT_VIEW_TYPE,
				(leaf) => new ChatSidebarView(leaf, this)
			);
	
			this.addRibbonIcon("message-square", "Open Companion Chat", () => {
				this.activateChatView();
			});
	
			this.addCommand({
				id: "open-chat",
				name: "Open Chat",
				callback: () => {
					this.activateChatView();
				},
			});
		}

		this.addSettingTab(new CompanionSettingsTab(this.app, this));
	}

	onunload() {
		// Unregister the chat view
		this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
	}
	
	async activateChatView() {
		const { workspace } = this.app;
		
		let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
		}
		
		workspace.revealLeaf(leaf);
	}

	fillStatusbar() {
		if (!this.statusBarItemEl) return;
		this.statusBarItemEl.setText(
			`Completion: ${this.enabled ? "enabled" : "disabled"}`
		);
	}

	loadPreset(name: string) {
		const preset = this.settings.presets.find(
			(preset) => preset.name == name
		);
		if (!preset) return;

		this.settings.provider = preset.provider;
		this.settings.model = preset.model;
		this.settings.provider_settings[preset.provider] = {
			settings: preset.provider_settings,
			models: {
				[preset.model]: preset.model_settings,
			},
		};
		this.saveSettings();
	}

	savePreset(name: string) {
		const preset = this.settings.presets.find(
			(preset) => preset.name == name
		);
		if (preset) {
			preset.provider = this.settings.provider;
			preset.model = this.settings.model;
			preset.provider_settings =
				this.settings.provider_settings[
					this.settings.provider
				].settings;
			preset.model_settings =
				this.settings.provider_settings[this.settings.provider].models[
					this.settings.model
				];
		} else {
			this.settings.presets.push({
				name: name,
				provider: this.settings.provider,
				model: this.settings.model,
				provider_settings:
					this.settings.provider_settings[this.settings.provider]
						.settings,
				model_settings:
					this.settings.provider_settings[this.settings.provider]
						.models[this.settings.model],
				enable_editor_command: false,
			});
		}
		this.saveSettings();
	}

	deletePreset(name: string) {
		this.settings.presets = this.settings.presets.filter(
			(preset) => preset.name != name
		);
		this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		
		// Ensure backward compatibility - initialize chatbot and autocompleter
		// settings from legacy settings if they're not already set
		if (!this.settings.chatbot || !this.settings.chatbot.provider) {
			this.settings.chatbot = {
				provider: this.settings.chatProvider || this.settings.provider,
				model: this.settings.chatModel || this.settings.model,
				provider_settings: this.settings.provider_settings || {},
				apiKey: ""
			};
		}
		
		if (!this.settings.autocompleter || !this.settings.autocompleter.provider) {
			this.settings.autocompleter = {
				provider: this.settings.autocompleteProvider || this.settings.provider,
				model: this.settings.autocompleteModel || this.settings.model,
				provider_settings: this.settings.provider_settings || {}
			};
		}
		
		// Also update legacy settings from new structure for compatibility
		this.settings.chatProvider = this.settings.chatbot.provider;
		this.settings.chatModel = this.settings.chatbot.model;
		this.settings.autocompleteProvider = this.settings.autocompleter.provider;
		this.settings.autocompleteModel = this.settings.autocompleter.model;
	}

	async saveSettings() {
		// Ensure chatbot and autocompleter settings are synchronized
		// with the legacy chatProvider/chatModel settings
		this.settings.chatProvider = this.settings.chatbot.provider;
		this.settings.chatModel = this.settings.chatbot.model;
		this.settings.autocompleteProvider = this.settings.autocompleter.provider;
		this.settings.autocompleteModel = this.settings.autocompleter.model;
		
		// Synchronize API keys between chatbot and autocompleter if they use the same provider
		this.synchronizeApiKeys();
		
		await this.saveData(this.settings);
		// Emit an event when settings are saved
		this.app.workspace.trigger("companion:settings-changed");
	}

	// Function to synchronize API keys between chatbot and autocompleter settings
	private synchronizeApiKeys() {
		// If both are using the same provider, share the API key
		if (this.settings.chatbot.provider === this.settings.autocompleter.provider) {
			// Get the provider ID
			const providerId = this.settings.chatbot.provider;
			
			// Ensure provider settings exist for both
			if (!this.settings.chatbot.provider_settings) {
				this.settings.chatbot.provider_settings = {};
			}
			if (!this.settings.autocompleter.provider_settings) {
				this.settings.autocompleter.provider_settings = {};
			}
			
			// Check if chatbot has provider settings for this provider
			if (this.settings.chatbot.provider_settings[providerId]) {
				try {
					// Parse chatbot provider settings to extract API key
					const chatbotSettings = this.settings.chatbot.provider_settings[providerId].settings;
					if (chatbotSettings) {
						const parsedChatbotSettings = JSON.parse(chatbotSettings);
						
						// If autocompleter doesn't have settings for this provider, initialize them
						if (!this.settings.autocompleter.provider_settings[providerId]) {
							this.settings.autocompleter.provider_settings[providerId] = {
								settings: "",
								models: {}
							};
						}
						
						// Get or initialize autocompleter settings
						let autocompleterSettings = "{}";
						if (this.settings.autocompleter.provider_settings[providerId]?.settings) {
							autocompleterSettings = this.settings.autocompleter.provider_settings[providerId].settings;
						}
						
						// Parse autocompleter settings
						let parsedAutocompleterSettings = {};
						try {
							parsedAutocompleterSettings = JSON.parse(autocompleterSettings);
						} catch (e) {
							console.error("Error parsing autocompleter settings:", e);
						}
						
						// If chatbot has an API key, copy it to autocompleter
						if (parsedChatbotSettings.api_key) {
							parsedAutocompleterSettings = {
								...parsedAutocompleterSettings,
								api_key: parsedChatbotSettings.api_key
							};
							
							// Update autocompleter settings
							this.settings.autocompleter.provider_settings[providerId].settings = 
								JSON.stringify(parsedAutocompleterSettings);
							
							// Also update the main chatbot API key field
							this.settings.chatbot.apiKey = parsedChatbotSettings.api_key;
						}
					}
				} catch (e) {
					console.error("Error synchronizing API keys:", e);
				}
			}
		}
	}

	async *triggerCompletion(): AsyncGenerator<Suggestion, void, unknown> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		if (!this.enabled) return;
		if ((view.editor as any)?.cm?.cm?.state?.keyMap === "vim") {
			// Don't complete if vim mode is enabled
			// (hehe I know more about the types than typescript does)
			// (thus I can use "as any" wooooo)
			return;
		}

		const cursor = view.editor.getCursor();
		const currentLine = view.editor.getLine(cursor.line);
		// if (!currentLine.length) {
		// 	yield {
		// 		display_suggestion: "",
		// 		complete_suggestion: "",
		// 	};
		// 	return;
		// } // Don't complete on empty lines
		// Screw it, I want it to work all the time
		const prefix = view.editor.getRange({ line: 0, ch: 0 }, cursor);
		const suffix = view.editor.getRange(cursor, {
			line: view.editor.lastLine(),
			ch: view.editor.getLine(view.editor.lastLine()).length,
		});

		yield* this.complete(prefix, suffix);
	}

	async acceptCompletion(editor: Editor) {
		const suggestion = this.last_used_model?.last_suggestion;
		if (suggestion) {
			editor.replaceRange(suggestion, editor.getCursor());
			editor.setCursor({
				ch:
					suggestion.split("\n").length > 1
						? suggestion.split("\n")[
								suggestion.split("\n").length - 1
						  ].length
						: editor.getCursor().ch + suggestion.length,
				line:
					editor.getCursor().line + suggestion.split("\n").length - 1,
			});
			this.force_fetch();
		}
	}

	async get_model(
		provider: string,
		model: string,
		apiKey?: string
	): Promise<CompletionCacher | null> {
		for (const cached_model of this.models) {
			if (
				cached_model.provider === provider &&
				cached_model.model === model
			) {
				return cached_model.cacher;
			}
		}
		const available_provider = available.find(
			(available_provider) => available_provider.id === provider
		);
		if (!available_provider) return null;
		
		let provider_settings = this.settings.provider_settings[provider];
		let provider_settings_string = provider_settings ? provider_settings.settings : "";
		
		// If apiKey is provided, update the provider settings with it
		if (apiKey && apiKey.trim() !== "") {
			try {
				// Parse existing settings or create new settings object
				let settings = {};
				if (provider_settings_string) {
					try {
						settings = JSON.parse(provider_settings_string);
					} catch (e) {
						console.error("Error parsing provider settings:", e);
					}
				}
				
				// Add the API key to the settings
				settings = { ...settings, api_key: apiKey.trim() };
				
				// Update the provider settings string
				provider_settings_string = JSON.stringify(settings);
				
				// Create modified provider settings object if needed
				if (!provider_settings) {
					provider_settings = {
						settings: provider_settings_string,
						models: {}
					};
				} else {
					provider_settings = {
						...provider_settings,
						settings: provider_settings_string
					};
				}
			} catch (e) {
				console.error("Error updating API key in provider settings:", e);
			}
		} 
		// If no specific API key is provided but the provider settings might contain one
		else if (provider_settings_string) {
			try {
				const settings = JSON.parse(provider_settings_string);
				// If there's an API key in provider settings but not in the specific apiKey param
				if (settings.api_key && settings.api_key.trim() !== "") {
					// For chatbot, update the chatbot.apiKey field to keep it in sync
					if (provider === this.settings.chatbot.provider) {
						this.settings.chatbot.apiKey = settings.api_key;
					}
				}
			} catch (e) {
				console.error("Error checking for API key in provider settings:", e);
			}
		}
		
		try {
			const available_models = await available_provider.get_models(provider_settings_string);
			const available_model: Model | undefined = available_models.find(
				(available_model: Model) => available_model.id == model
			);
			if (!available_model) return null;
			const cached = new CompletionCacher(
				available_model,
				provider_settings && provider_settings.models && provider_settings.models[available_model.id]
					? provider_settings.models[available_model.id]
					: "",
				this.settings.accept,
				this.settings.keybind == null
			);
			this.models.push({
				provider,
				model,
				cacher: cached,
			});
			return cached;
		} catch (e) {
			console.error("Error getting models for provider:", e);
			new Notice(`Error loading model: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	async load_model(model: CompletionCacher) {
		if (this.last_used_model?.model.id === model.model.id) return;
		await this.last_used_model?.model?.unload?.();
		await model?.model?.load?.();
	}

	async *_complete(
		prefix: string,
		suffix: string,
		provider: string,
		model: string
	): AsyncGenerator<Suggestion> {
		const cacher = await this.get_model(provider, model);
		if (!cacher) throw { name: "ModelNotFound" };
		await this.load_model(cacher);
		for await (let completion of cacher.complete(
			{
				prefix: prefix,
				suffix: suffix,
			},
			this.settings.stream
		)) {
			this.last_used_model = cacher;
			yield completion;
		}
	}

	async select_first_available_model() {
		const provider = available.find(
			(provider) => provider.id === this.settings.provider
		);
		const provider_settings =
			this.settings.provider_settings[this.settings.provider];
		this.settings.model =
			(await provider
				?.get_models(
					provider_settings ? provider_settings.settings : ""
				)
				.then((models) => models[0].id)) || "";
	}

	async *fallback_complete(
		prefix: string,
		suffix: string
	): AsyncGenerator<Suggestion> {
		if (this.settings.fallback) {
			try {
				const fallback = this.settings.presets.find(
					(preset) => preset.name === this.settings.fallback
				);
				if (!fallback) return;
				const completion = this._complete(
					prefix,
					suffix,
					fallback.provider,
					fallback.model
				);
				if (!completion) return;
				yield* completion;
			} catch (e) {
				new Notice(`Error completing (fallback): ${e.message}`);
			}
		}
	}

	async *complete(
		prefix: string,
		suffix: string
	): AsyncGenerator<Suggestion> {
		if (!this.settings.enableAutocomplete) {
			return;
		}
		
		const provider = this.settings.autocompleteProvider || this.settings.provider;
		const model = this.settings.autocompleteModel || this.settings.model;
		
		for await (const suggestion of this._complete(
			prefix,
			suffix,
			provider,
			model
		)) {
			yield suggestion;
		}
	}

	async get_chat_model(): Promise<CompletionCacher | null> {
		return this.get_model(
			this.settings.chatbot.provider, 
			this.settings.chatbot.model, 
			this.settings.chatbot.apiKey
		);
	}

	async get_autocomplete_model(): Promise<CompletionCacher | null> {
		return this.get_model(
			this.settings.autocompleter.provider, 
			this.settings.autocompleter.model
		);
	}
}

class PresetChooserModal extends FuzzySuggestModal<CompanionModelSettings> {
	plugin: Companion;

	constructor(plugin: Companion) {
		super(plugin.app);
		this.plugin = plugin;
	}

	getItems(): CompanionModelSettings[] {
		return this.plugin.settings.presets;
	}

	getItemText(item: CompanionModelSettings): string {
		return item.name;
	}

	onChooseItem(
		preset: CompanionModelSettings,
		_evt: MouseEvent | KeyboardEvent
	) {
		this.plugin.loadPreset(preset.name);
		new Notice("Loaded preset " + preset.name);
	}
}

class CompanionSettingsTab extends PluginSettingTab {
	plugin: Companion;
	root: any;
	reload_signal: { reload: boolean };

	constructor(app: App, plugin: Companion) {
		super(app, plugin);
		this.plugin = plugin;
		this.reload_signal = { reload: false };
	}

	display(): void {
		const { containerEl } = this;
		this.reload_signal.reload = false;
		this.root = createRoot(containerEl);
		this.root.render(
			<React.StrictMode>
				<SettingsComponent
					plugin={this.plugin}
					reload_signal={this.reload_signal}
				/>
			</React.StrictMode>
		);
	}

	hide(): void {
		this.root.unmount();
		super.hide();

		if (this.reload_signal.reload) {
			this.reload_signal.reload = false;
			const reload = async () => {
				const app: any = this.plugin.app; // Otherwise typescript complains
				await app.plugins.disablePlugin("companion");
				await app.plugins.enablePlugin("companion");
			};
			reload();
		}
	}
}
