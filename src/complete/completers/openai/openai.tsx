import React from "react";
import { Notice } from "obsidian";
import { Completer, Model, Prompt } from "../../complete";
import available_models from "./models.json";
import {
	SettingsUI as ProviderSettingsUI,
	Settings,
	parse_settings,
} from "./provider_settings";
import OpenAI from "openai";
import SettingsItem from "../../../components/SettingsItem";
import { z } from "zod";

export const model_settings_schema = z.object({
	context_length: z.number().int().positive(),
	max_tokens: z.number().int().positive().optional(),
	temperature: z.number().min(0).max(2).optional(),
});
export type ModelSettings = z.infer<typeof model_settings_schema>;
const parse_model_settings = (settings: string): ModelSettings => {
	try {
		return model_settings_schema.parse(JSON.parse(settings));
	} catch (e) {
		return {
			context_length: 4000,
			max_tokens: 2048,
			temperature: 0.7,
		};
	}
};

export default class OpenAIModel implements Model {
	id: string;
	name: string;
	description: string;
	rate_limit_notice: Notice | null = null;
	rate_limit_notice_timeout: number | null = null;

	provider_settings: Settings;
	Settings = ({
		settings,
		saveSettings,
	}: {
		settings: string | null;
		saveSettings: (settings: string) => void;
	}) => {
		const parsedSettings = parse_model_settings(settings || "");
		return (
			<>
				<SettingsItem
					name="Context length"
					description="In characters, how much context should the model get"
				>
					<input
						type="number"
						value={parsedSettings.context_length}
						aria-label="Context length"
						onChange={(e) =>
							saveSettings(
								JSON.stringify({
									...parsedSettings,
									context_length: parseInt(e.target.value),
								})
							)
						}
					/>
				</SettingsItem>
				<SettingsItem
					name="Max tokens"
					description="Maximum number of tokens in the response (higher = longer responses)"
				>
					<input
						type="number"
						value={parsedSettings.max_tokens || 2048}
						aria-label="Max tokens"
						onChange={(e) =>
							saveSettings(
								JSON.stringify({
									...parsedSettings,
									max_tokens: parseInt(e.target.value),
								})
							)
						}
					/>
				</SettingsItem>
				<SettingsItem
					name="Temperature"
					description="Controls randomness: 0 = deterministic, higher = more random"
				>
					<input
						type="number"
						step="0.1"
						min="0"
						max="2"
						value={parsedSettings.temperature || 0.7}
						aria-label="Temperature"
						onChange={(e) =>
							saveSettings(
								JSON.stringify({
									...parsedSettings,
									temperature: parseFloat(e.target.value),
								})
							)
						}
					/>
				</SettingsItem>
			</>
		);
	};

	constructor(
		id: string,
		name: string,
		description: string,
		provider_settings: string
	) {
		this.id = id;
		this.name = name;
		this.description = description;
		this.provider_settings = parse_settings(provider_settings);
	}

	isChatModel(modelId: string): boolean {
		return modelId.includes("gpt-") && !modelId.startsWith("text-");
	}

	async complete(prompt: Prompt, settings: string): Promise<string> {
		const parsed_settings = parse_model_settings(settings);
		const api = new OpenAI({
			apiKey: this.provider_settings.api_key,
			dangerouslyAllowBrowser: true,
		});

		try {
			// Use chat completions API for chat models (GPT-3.5, GPT-4)
			if (this.isChatModel(this.id)) {
				const response = await api.chat.completions.create({
					model: this.id,
					messages: [
						{
							role: "user",
							content: prompt.prefix.slice(-parsed_settings.context_length),
						}
					],
					max_tokens: parsed_settings.max_tokens || 2048, // Ensure we get complete responses
					temperature: parsed_settings.temperature || 0.7,
				});

				return response.choices[0].message.content || "";
			} 
			// Use completions API for legacy models (text-davinci, etc.)
			else {
				const response = await api.completions.create({
					model: this.id,
					prompt: prompt.prefix.slice(-parsed_settings.context_length),
					max_tokens: parsed_settings.max_tokens || 2048, // Increased from 64 to ensure complete responses
					temperature: parsed_settings.temperature || 0.7,
				});

				return response.choices[0].text || "";
			}
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		const parsed_settings = parse_model_settings(settings);
		const api = new OpenAI({
			apiKey: this.provider_settings.api_key,
			dangerouslyAllowBrowser: true,
		});

		try {
			// Use chat completions API with streaming for chat models
			if (this.isChatModel(this.id)) {
				const stream = await api.chat.completions.create({
					model: this.id,
					messages: [
						{
							role: "user",
							content: prompt.prefix.slice(-parsed_settings.context_length),
						}
					],
					max_tokens: parsed_settings.max_tokens || 2048,
					temperature: parsed_settings.temperature || 0.7,
					stream: true,
				});

				for await (const chunk of stream) {
					yield chunk.choices[0]?.delta?.content || "";
				}
			} 
			// Use completions API with streaming for legacy models
			else {
				const stream = await api.completions.create({
					model: this.id,
					prompt: prompt.prefix.slice(-parsed_settings.context_length),
					max_tokens: parsed_settings.max_tokens || 2048,
					temperature: parsed_settings.temperature || 0.7,
					stream: true,
				});

				for await (const chunk of stream) {
					yield chunk.choices[0]?.text || "";
				}
			}
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	create_rate_limit_notice() {
		if (this.rate_limit_notice) {
			window.clearTimeout(this.rate_limit_notice_timeout!);
			this.rate_limit_notice_timeout = window.setTimeout(() => {
				this.rate_limit_notice?.hide();
				this.rate_limit_notice = null;
				this.rate_limit_notice_timeout = null;
			}, 5000);
		} else {
			this.rate_limit_notice = new Notice(
				'Rate limit exceeded. Check the "Rate limits" section in the plugin settings for more information.',
				250000
			);
			this.rate_limit_notice_timeout = window.setTimeout(() => {
				this.rate_limit_notice?.hide();
				this.rate_limit_notice = null;
				this.rate_limit_notice_timeout = null;
			}, 5000);
		}
	}

	create_api_key_notice() {
		const notice: any = new Notice("", 5000);
		const notice_element = notice.noticeEl as HTMLElement;
		notice_element.createEl("span", {
			text: "OpenAI API key is invalid. Please double-check your ",
		});
		notice_element.createEl("a", {
			text: "API key",
			href: "https://platform.openai.com/account/api-keys",
		});
		notice_element.createEl("span", {
			text: " in the plugin settings.",
		});
	}

	parse_api_error(e: { status?: number }) {
		if (e.status === 429) {
			this.create_rate_limit_notice();
			throw new Error();
		} else if (e.status === 401) {
			this.create_api_key_notice();
			throw new Error();
		}
		throw e;
	}
}

export class OpenAIComplete implements Completer {
	id: string = "openai";
	name: string = "OpenAI";
	description: string = "OpenAI's models including GPT-3.5 and GPT-4";

	async get_models(settings: string) {
		return available_models.map(
			(model) =>
				new OpenAIModel(
					model.id,
					model.name,
					model.description,
					settings
				)
		);
	}

	Settings = ProviderSettingsUI;
}
