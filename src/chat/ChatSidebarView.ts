import { ItemView, WorkspaceLeaf, Events } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import * as React from "react";
import { ChatView } from "./ChatView";
import Companion from "../main";

export const CHAT_VIEW_TYPE = "companion-chat-view";

// Declare the custom event
declare module "obsidian" {
  interface Workspace {
    on(name: "companion:settings-changed", callback: () => void): EventRef;
    trigger(name: "companion:settings-changed"): void;
  }
}

export class ChatSidebarView extends ItemView {
  private root: Root | null = null;
  private plugin: Companion;

  constructor(leaf: WorkspaceLeaf, plugin: Companion) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Companion Chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("companion-chat-container");

    const reactContainer = container.createDiv();
    this.root = createRoot(reactContainer);
    
    this.renderView();

    // Listen for settings changes to update the view
    this.registerEvent(
      this.app.workspace.on("companion:settings-changed", () => {
        this.renderView();
      })
    );
  }

  private renderView(): void {
    if (!this.root) return;
    
    // Get settings from the plugin
    const { chatbot } = this.plugin.settings;
    
    // Ensure API key is properly accessed and validated
    const apiKey = chatbot?.apiKey || "";
    
    // Log for debugging (don't log the actual key)
    if (!apiKey || apiKey.trim() === "") {
      console.warn("Warning: No API key set for chat functionality");
    } else {
      console.log("API key is set for chat functionality");
    }
    
    this.root.render(
      React.createElement(ChatView, {
        app: this.app,
        getModel: (provider: string, model: string) => {
          // Create a wrapper around get_model that injects the API key for providers that need it
          return this.plugin.get_model(provider, model, apiKey);
        },
        provider: chatbot.provider,
        model: chatbot.model
      })
    );
  }

  async onClose(): Promise<void> {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
} 