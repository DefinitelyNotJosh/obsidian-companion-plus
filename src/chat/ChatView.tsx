import * as React from "react";
import { useState, useEffect, useRef, useCallback } from "react";
import { App, Notice, TFile, Editor, MarkdownView, normalizePath } from "obsidian";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  id: string;
}

interface ChatSession {
  id: string;
  title: string;
}

interface ChatViewProps {
  app: App;
  getModel: (provider: string, model: string) => Promise<any | null>;
  provider: string;
  model: string;
}

// Generate a unique ID for messages and sessions
const generateId = () => `id_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Define the ActionIntent type for handling file operations
type ActionIntent = {
  type: "write" | "create" | "delete" | "remove_content" | null;
  content?: string;      // For write/create operations
  filename?: string;     // For create/delete operations
  pattern?: string;      // For content removal (pattern to match)
  startLine?: number;    // For content removal (line range)
  endLine?: number;      // For content removal (line range)
  description?: string;  // Human-readable description of the action
};

// Additional type for pending file operations
type PendingOperation = 
  | { type: "write"; content: string; filename?: string }
  | { type: "create"; filename: string; content: string }
  | { type: "delete"; file: TFile }
  | { type: "remove_content"; pattern: string; startLine: number; endLine: number; filename?: string };

// Track pending changes that are already written but need acceptance
type PendingChange = {
  id: string;
  fileId: string; // File path used as ID
  fileName: string;
  content: string;
  status: 'pending' | 'accepted' | 'rejected';
  // Add expanded property to track if the content is expanded in the chat view
  expanded: boolean;
  // Add source message ID to track which message created this change
  messageId: string;
};

// Function to check if a message indicates file creation
const isFileCreationRequest = (message: string) => {
  const createIndicators = [
    // Original indicators
    "create a new file",
    "create file",
    "make a new file",
    "new file called",
    "create a file named",
    "start a file called",
    "make a file called",
    "create a new file",
    "create the file",
    "make a file named",
    "generate a new file",
    "start a new file",
    "create a file called",
    "new file named",
    "set up a file called",
    "set up a new file",
    "begin a file named",
    "open a new file called",
    "create new file",
    "make file called",
    "generate file named",
    "start file named",
    "create a document called",
    "make a document named",
    "new document called",
    "start a document named",
    "create something called",
    "make a note file called",
    "generate a note file",
    "set up a file named",
    "create file with name",
    "make a new note called",
    "start a note file",
    "create a blank file called",
    "new file with",
    "make a fresh file",
    "create a fresh file named",
    "begin a new file with",
    "start fresh file called",
    "create and name it",
    "make a file and call it",
  ];
  return createIndicators.some(indicator => message.toLowerCase().includes(indicator));
};

// Function to check if a message indicates file deletion
const isFileDeletionRequest = (message: string) => {
  const deleteIndicators = [
    // Original indicators
    "delete file",
    "remove file",
    "delete the file",
    "erase the file",
    "get rid of the file",

    // Expanded variations
    "delete this file",
    "remove this file",
    "erase this file",
    "wipe out the file",
    "get rid of this file",
    "trash the file",
    "discard the file",
    "delete file called",
    "remove file named",
    "erase file called",
    "delete that file",
    "remove that file",
    "clear out the file",
    "wipe the file",
    "delete my file",
    "remove my file",
    "erase my file",
    "throw away the file",
    "dump the file",
    "scrap the file",
    "delete file with name",
    "remove file with",
    "erase file named",
    "get rid of file called",
    "trash file named",
    "discard file called",
    "delete the document",
    "remove the document",
    "erase the document",
    "wipe out this file",
    "clear the file",
  ];
  return deleteIndicators.some(indicator => message.toLowerCase().includes(indicator));
};

// Function to check if a message indicates content removal
const isContentRemovalRequest = (message: string) => {
  const removeIndicators = [
    // Original indicators
    "remove section",
    "delete section",
    "remove the section",
    "delete the section",
    "remove paragraph",
    "delete paragraph",
    "remove content",
    "delete content",
    "remove the paragraph",
    "delete the paragraph",

    // Expanded variations
    "remove this section",
    "delete this section",
    "erase the section",
    "wipe out the section",
    "remove that section",
    "delete that section",
    "clear the section",
    "remove this paragraph",
    "delete this paragraph",
    "erase this paragraph",
    "wipe out the paragraph",
    "remove that paragraph",
    "delete that paragraph",
    "clear the paragraph",
    "remove text",
    "delete text",
    "erase text",
    "wipe out text",
    "remove this text",
    "delete this text",
    "clear this text",
    "remove the content",
    "delete the content",
    "erase the content",
    "wipe out the content",
    "remove this content",
    "delete this content",
    "clear this content",
    "remove line",
    "delete line",
    "erase line",
    "remove this line",
    "delete this line",
    "clear this line",
    "remove the line",
    "delete the line",
    "erase the line",
    "cut out the section",
    "cut the paragraph",
    "take out the content",
    "strip out this text",
    "remove part about",
    "delete part about",
    "erase the part about",
    "remove the bit about",
    "delete the bit about",
  ];
  return removeIndicators.some(indicator => message.toLowerCase().includes(indicator));
};

export const ChatView: React.FC<ChatViewProps> = ({ app, getModel, provider, model }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentFile, setCurrentFile] = useState<TFile | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const activeEditorRef = useRef<Editor | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [expandedMessageChanges, setExpandedMessageChanges] = useState<string[]>([]);

  // Add CSS styles for pending changes
  const styles = `
    .chat-pending-changes {
      margin-top: 10px;
      border-radius: 6px;
      overflow: hidden;
    }
    
    .chat-pending-change {
      margin-top: 8px;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--background-modifier-border);
      background-color: var(--background-secondary);
    }
    
    .chat-pending-change-pending {
      border-left: 3px solid #7e6df2;
    }
    
    .chat-pending-change-accepted {
      border-left: 3px solid #4caf50;
    }
    
    .chat-pending-change-rejected {
      border-left: 3px solid #f44336;
      opacity: 0.7;
    }
    
    .chat-pending-change-header {
      display: flex;
      justify-content: space-between;
      padding: 8px 12px;
      background-color: var(--background-modifier-hover);
      cursor: pointer;
      font-weight: 500;
    }
    
    .chat-pending-change-content {
      padding: 10px;
      max-height: 300px;
      overflow: auto;
      background-color: var(--background-primary);
      border-top: 1px solid var(--background-modifier-border);
    }
    
    .chat-pending-change-content pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--font-monospace);
      font-size: 0.9em;
    }
    
    .chat-pending-change-actions {
      display: flex;
      padding: 8px;
      border-top: 1px solid var(--background-modifier-border);
      gap: 8px;
    }
    
    .chat-pending-change-accept, 
    .chat-pending-change-reject {
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      border: none;
    }
    
    .chat-pending-change-accept {
      background-color: #7e6df2;
      color: white;
    }
    
    .chat-pending-change-reject {
      background-color: var(--background-modifier-border);
    }
    
    .chat-pending-change-status {
      padding: 8px 12px;
      color: var(--text-muted);
      font-size: 0.9em;
      border-top: 1px solid var(--background-modifier-border);
    }
    
    .companion-chat-accept-all-container {
      display: flex;
      justify-content: center;
      margin-top: 10px;
      margin-bottom: 10px;
    }
    
    .companion-chat-accept-all-button,
    .companion-chat-reject-all-button {
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      margin: 0 5px;
      border: none;
    }
    
    .companion-chat-accept-all-button {
      background-color: #7e6df2;
      color: white;
    }
    
    .companion-chat-reject-all-button {
      background-color: var(--background-modifier-border);
    }
  `;

  // Load chat sessions from localStorage on mount
  useEffect(() => {
    const savedSessions = localStorage.getItem("chat-sessions");
    if (savedSessions) {
      const sessions: ChatSession[] = JSON.parse(savedSessions);
      setChatSessions(sessions);
      if (sessions.length > 0) {
        setCurrentSessionId(sessions[0].id);
      }
    } else {
      createNewChat();
    }
  }, []);

  // Load messages for the current session
  // In ChatView component, replace the useEffect for loading messages:
useEffect(() => {
  if (currentSessionId) {
    const savedMessages = localStorage.getItem(`chat-history-${currentSessionId}`);
    // Reset messages to an empty array before loading session-specific messages
    setMessages(savedMessages ? JSON.parse(savedMessages) : []);
    // Also reset pending changes when switching sessions to avoid cross-session pollution
    setPendingChanges([]);
  }
}, [currentSessionId]);

  // Save messages to localStorage when they change
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      localStorage.setItem(`chat-history-${currentSessionId}`, JSON.stringify(messages));
    }
  }, [messages, currentSessionId]);

  // Track the current active file and editor
  useEffect(() => {
    const updateCurrentFile = () => {
      const activeFile = app.workspace.getActiveFile();
      setCurrentFile(activeFile);
      const activeLeaf = app.workspace.activeLeaf;
      if (activeLeaf && activeLeaf.view instanceof MarkdownView) {
        activeEditorRef.current = activeLeaf.view.editor;
      } else {
        activeEditorRef.current = null;
      }
    };
    updateCurrentFile();
    app.workspace.on("file-open", updateCurrentFile);
    return () => app.workspace.off("file-open", updateCurrentFile);
  }, [app.workspace]);

  // Auto-scroll to the bottom when messages are added
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Handle model changes from settings
  useEffect(() => {
    // Only notify on model changes if we're in an existing conversation with messages
    if (messages.length > 0) {
      const modelChangeMessage: ChatMessage = {
        role: "assistant",
        content: `Model changed to ${provider} / ${model}. This conversation will continue with the new model.`,
        id: generateId(),
      };
      setMessages(prev => [...prev, modelChangeMessage]);
    }
  }, [provider, model]);

  // Create a new chat session
  const createNewChat = useCallback(() => {
    const newSessionId = generateId();
    const newSession: ChatSession = { id: newSessionId, title: "New Chat" };
    setChatSessions((prev) => [...prev, newSession]);
    setCurrentSessionId(newSessionId);
    setMessages([]);
    localStorage.setItem("chat-sessions", JSON.stringify([...chatSessions, newSession]));
  }, [chatSessions]);

  // Delete a chat session
  const deleteChat = useCallback((sessionId: string) => {
    if (chatSessions.length <= 1) {
      new Notice("Cannot delete the only chat session.");
      return;
    }
    const updatedSessions = chatSessions.filter((session) => session.id !== sessionId);
    setChatSessions(updatedSessions);
    localStorage.setItem("chat-sessions", JSON.stringify(updatedSessions));
    localStorage.removeItem(`chat-history-${sessionId}`);
    if (sessionId === currentSessionId) {
      setCurrentSessionId(updatedSessions[0].id);
    }
    new Notice("Chat session deleted");
  }, [chatSessions, currentSessionId]);

  // Function to get a file from the vault by name, supporting fuzzy matching
  const getFileByName = useCallback((filename: string): TFile | null => {
    if (!filename) return null;
    
    // Clean and normalize the path
    let path = filename;
    if (!path.endsWith(".md")) path += ".md";
    path = normalizePath(path);
    
    // First try exact path match
    const exactFile = app.vault.getAbstractFileByPath(path);
    if (exactFile instanceof TFile) {
      return exactFile;
    }
    
    // If exact match fails, try fuzzy matching on filename
    const allFiles = app.vault.getMarkdownFiles();
    const filenameWithoutPath = path.split('/').pop() || path;
    
    // Try exact filename match first (ignoring path)
    const fileMatch = allFiles.find(file => file.name.toLowerCase() === filenameWithoutPath.toLowerCase());
    if (fileMatch) return fileMatch;
    
    // If still no match, try closest match
    let bestMatch: TFile | null = null;
    let bestScore = 0;
    
    for (const file of allFiles) {
      // Simple similarity score based on common characters
      const filenameChars = file.name.toLowerCase().split('');
      const searchChars = filenameWithoutPath.toLowerCase().split('');
      const commonChars = filenameChars.filter(char => searchChars.includes(char));
      const score = commonChars.length / Math.max(filenameChars.length, searchChars.length);
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = file;
      }
    }
    
    // Only return if it's a reasonably good match
    return bestScore > 0.5 ? bestMatch : null;
  }, [app.vault]);

  // Function to get file content by name
  const getFileContent = useCallback(async (filename: string): Promise<{success: boolean, content?: string, file?: TFile, message?: string}> => {
    const file = getFileByName(filename);
    
    if (!file) {
      return {
        success: false,
        message: `File "${filename}" not found.`
      };
    }
    
    try {
      const content = await app.vault.read(file);
      return {
        success: true,
        content,
        file
      };
    } catch (error) {
      console.error("Error reading file:", error);
      return {
        success: false,
        message: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
  }, [app.vault, getFileByName]);

  const parseContentForWriting = useCallback((content: string): string => {
    // Remove LLM context markers and other non-content elements
    let parsedContent = content;
    
    // Remove any common prefixes like "Here's a list of..." or "I've created..."
    parsedContent = parsedContent.replace(/^(here('s| is|'re)|i('ve| have)|i('ll| will)|i (can|could)|let me|sure|certainly|absolutely|of course)[^]*?:\s*/i, '');
    
    // Remove confirmation questions like "Would you like me to..."
    parsedContent = parsedContent.replace(/\n\nwould you like [^]*?$/i, '');
    
    // Remove sentences like "I've written..." or "I've created a list..."
    parsedContent = parsedContent.replace(/\n\n(here('s| is|'re)|i('ve| have)|i('ll| will)) [^]*?\.\s*$/i, '');
    
    // Remove any "Does this look good?" type questions
    parsedContent = parsedContent.replace(/\n\n(does this|how does this|is this|would this) [^]*?$/i, '');
    
    return parsedContent.trim();
  }, []);

  // Updated function to handle file write requests and automatically write to files with highlighting
  const writeToFile = useCallback(async (filename: string | null, content: string) => {
    // If no filename is provided, default to current file
    const targetFile = filename ? getFileByName(filename) : currentFile;
    
    if (!targetFile) {
      return {
        success: false,
        message: `No target file found. ${filename ? `File "${filename}" not found.` : "No file is open."}`
      };
    }

    try {
      // Create a unique ID for this change
      const changeId = generateId();
      
      // Filter the content to keep only relevant information
      const relevantContent = parseContentForWriting(content);
      
      // Get the current file content
      const fileContent = await app.vault.read(targetFile);
      
      // Determine the best position to insert the content
      // For now, we'll use a simple heuristic - insert after the first heading or at the end
      let insertPosition = 0;
      const lines = fileContent.split('\n');
      
      // Try to find a relevant heading or section
      const headingRegex = /^#+\s+.+$/;
      
      // Find the last heading in the file
      let lastHeadingIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (headingRegex.test(lines[i])) {
          lastHeadingIndex = i;
        }
      }
      
      // If we found a heading, insert after it and its immediate content
      if (lastHeadingIndex >= 0) {
        // Find the end of the current section (next heading or EOF)
        let sectionEnd = lines.length;
        for (let i = lastHeadingIndex + 1; i < lines.length; i++) {
          if (headingRegex.test(lines[i])) {
            sectionEnd = i;
            break;
          }
        }
        
        // Insert at the end of the current section
        insertPosition = sectionEnd;
      } else {
        // If no heading found, insert at the end of the file
        insertPosition = lines.length;
      }
      
      // Format the content with green highlighting
      const highlightedContent = `\n\n<div style="background-color: rgba(144, 238, 144, 0.2); padding: 10px; border-left: 3px solid #4caf50; margin: 10px 0;" data-change-id="${changeId}">\n${relevantContent}\n</div>\n`;
      
      // Insert the highlighted content at the determined position
      lines.splice(insertPosition, 0, highlightedContent);
      const newContent = lines.join('\n');
      
      // Write the updated content to the file
      await app.vault.modify(targetFile, newContent);
      
      // Add to pending changes for tracking
      const newPendingChange: PendingChange = {
        id: changeId,
        fileId: targetFile.path,
        fileName: targetFile.name,
        content: relevantContent,
        status: 'pending',
        expanded: true, // Start expanded
        messageId: changeId
      };
      
      setPendingChanges(prev => [...prev, newPendingChange]);
      
      return {
        success: true,
        message: `Content added to ${targetFile.name}. Changes highlighted in the file.`,
        changeId
      };
    } catch (error) {
      console.error("Error writing to file:", error);
      return {
        success: false,
        message: `Failed to write to file: ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
  }, [app.vault, currentFile, getFileByName, parseContentForWriting]);

  // Function to accept a change
  // In ChatView component, update acceptChange:
const acceptChange = useCallback(async (changeId: string) => {
  const change = pendingChanges.find(c => c.id === changeId);
  if (!change) return { success: false, message: "Change not found." };

  try {
    const targetFile = app.vault.getAbstractFileByPath(change.fileId);
    if (!(targetFile instanceof TFile)) {
      // If the file doesn't exist, treat it as a new file creation
      return createNewFileFromChange(changeId);
    }

    const fileContent = await app.vault.read(targetFile);
    // Use a more precise regex that matches the exact div structure from writeToFile
    const highlightRegex = new RegExp(
      `<div style="background-color: rgba\\(144, 238, 144, 0.2\\); padding: 10px; border-left: 3px solid #4caf50; margin: 10px 0;" data-change-id="${changeId}">\\n([\\s\\S]*?)\\n</div>`,
      'g'
    );
    const newContent = fileContent.replace(highlightRegex, '$1'); // Keep only the content
    await app.vault.modify(targetFile, newContent);

    setPendingChanges(prev =>
      prev.map(c => (c.id === changeId ? { ...c, status: 'accepted' } : c))
    );

    return {
      success: true,
      message: `Changes accepted in ${change.fileName}.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to accept change: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}, [app.vault, pendingChanges]);

// Update rejectChange:
const rejectChange = useCallback(async (changeId: string) => {
  const change = pendingChanges.find(c => c.id === changeId);
  if (!change) return { success: false, message: "Change not found." };

  try {
    const targetFile = app.vault.getAbstractFileByPath(change.fileId);
    if (!(targetFile instanceof TFile)) return { success: true, message: "File not found, nothing to reject." };

    const fileContent = await app.vault.read(targetFile);
    const highlightRegex = new RegExp(
      `\\n*<div style="background-color: rgba\\(144, 238, 144, 0.2\\); padding: 10px; border-left: 3px solid #4caf50; margin: 10px 0;" data-change-id="${changeId}">\\n[\\s\\S]*?\\n</div>\\n*`,
      'g'
    );
    const newContent = fileContent.replace(highlightRegex, '');
    await app.vault.modify(targetFile, newContent);

    setPendingChanges(prev =>
      prev.map(c => (c.id === changeId ? { ...c, status: 'rejected' } : c))
    );

    return {
      success: true,
      message: `Changes rejected and removed from ${change.fileName}.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to reject change: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}, [app.vault, pendingChanges]);

  // Function to create a new file from a pending change
  const createNewFileFromChange = useCallback(async (changeId: string) => {
    const change = pendingChanges.find(c => c.id === changeId);
    if (!change) return;
    
    try {
      // Normalize the path and ensure it has the proper extension
      let normalizedPath = normalizePath(change.fileName);
      if (!normalizedPath.endsWith(".md")) {
        normalizedPath += ".md";
      }
      
      // Check if file exists
      const existingFile = app.vault.getAbstractFileByPath(normalizedPath);
      if (existingFile) {
        // If the file exists, append to it
        if (existingFile instanceof TFile) {
          const content = await app.vault.read(existingFile);
          await app.vault.modify(existingFile, content + `\n\n${change.content}`);
        } else {
          return {
            success: false,
            message: `Cannot write to ${normalizedPath}: not a file.`
          };
        }
      } else {
        // Create the file
        await app.vault.create(normalizedPath, change.content);
      }
      
      // Update pending changes
      setPendingChanges(prev => 
        prev.map(c => c.id === changeId ? {...c, status: 'accepted'} : c)
      );
      
      return {
        success: true,
        message: `File '${normalizedPath}' has been created.`
      };
    } catch (error) {
      console.error("Error creating file:", error);
      return {
        success: false,
        message: `Failed to create file: ${error instanceof Error ? error.message : "Unknown error"}`
      };
    }
  }, [app.vault, pendingChanges]);

  // Function to accept all pending changes
  const acceptAllChanges = useCallback(async () => {
    const pendingIds = pendingChanges
      .filter(change => change.status === 'pending')
      .map(change => change.id);
    
    if (pendingIds.length === 0) return;
    
    const results = await Promise.all(pendingIds.map(id => {
      const change = pendingChanges.find(c => c.id === id);
      if (!change) return null;
      
      // Check if this is a file creation or a file update
      if (app.vault.getAbstractFileByPath(change.fileId)) {
        // Existing file, use acceptChange
        return acceptChange(id);
      } else {
        // New file, use createNewFileFromChange
        return createNewFileFromChange(id);
      }
    }));
    
    const successCount = results.filter(r => r && r.success).length;
    
    return {
      success: successCount > 0,
      message: `Accepted ${successCount} of ${pendingIds.length} pending changes.`
    };
  }, [pendingChanges, acceptChange, createNewFileFromChange, app.vault]);

  // Function to reject all pending changes
  const rejectAllChanges = useCallback(async () => {
    const pendingIds = pendingChanges
      .filter(change => change.status === 'pending')
      .map(change => change.id);
    
    if (pendingIds.length === 0) return;
    
    const results = await Promise.all(pendingIds.map(id => rejectChange(id)));
    const successCount = results.filter(r => r && r.success).length;
    
    return {
      success: successCount > 0,
      message: `Rejected ${successCount} of ${pendingIds.length} pending changes.`
    };
  }, [pendingChanges, rejectChange]);

  // Utility function to escape special characters in regex
  const escapeRegExp = useCallback((string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }, []);

  // Function to remove content from any file
  const removeContentFromFile = useCallback(async (filename: string | null, pattern: string, startLine: number, endLine: number) => {
    // If no filename is provided, default to current file
    const targetFile = filename ? getFileByName(filename) : currentFile;
    
    if (!targetFile) {
      return {
        success: false,
        message: `No target file found. ${filename ? `File "${filename}" not found.` : "No file is open."}`
      };
    }
    
    try {
      // Get the current content
      const currentContent = await app.vault.read(targetFile);
      const lines = currentContent.split("\n");
      
      // If startLine and endLine are provided, use them
      if (startLine >= 0 && endLine < lines.length && startLine <= endLine) {
        // Remove the specified lines
        lines.splice(startLine, endLine - startLine + 1);
        const newContent = lines.join("\n");
        await app.vault.modify(targetFile, newContent);
        
        return {
          success: true,
          message: `Content from lines ${startLine+1} to ${endLine+1} has been removed from ${targetFile.name}.`,
        };
      } 
      // Otherwise try to find content by pattern
      else if (pattern) {
        // Try to find the pattern in the content
        const regex = new RegExp(pattern, "i");
        let contentRemoved = false;
        
        // If we have an editor and it's the active file, use it for more precise editing
        if (targetFile === currentFile && activeEditorRef.current) {
          const editor = activeEditorRef.current;
          const content = editor.getValue();
          const match = content.match(regex);
          
          if (match && match.index !== undefined) {
            const startPos = editor.offsetToPos(match.index);
            const endPos = editor.offsetToPos(match.index + match[0].length);
            editor.replaceRange("", startPos, endPos);
            contentRemoved = true;
          }
        } 
        // Fallback: modify the whole file
        else {
          const newContent = currentContent.replace(regex, "");
          if (newContent !== currentContent) {
            await app.vault.modify(targetFile, newContent);
            contentRemoved = true;
          }
        }
        
        if (contentRemoved) {
          return {
            success: true,
            message: `Content matching "${pattern}" has been removed from ${targetFile.name}.`,
          };
        } else {
          return {
            success: false,
            message: `Could not find content matching "${pattern}" in ${targetFile.name}.`,
          };
        }
      } else {
        return {
          success: false,
          message: "No pattern or line range provided for content removal.",
        };
      }
    } catch (error) {
      console.error("Error removing content:", error);
      return {
        success: false,
        message: `Failed to remove content: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }, [app.vault, currentFile, activeEditorRef, getFileByName]);

  // Function to create a new file
  const createNewFile = useCallback(async (filename: string, content: string) => {
    try {
      // Normalize the path and ensure it has the proper extension
      let normalizedPath = normalizePath(filename);
      if (!normalizedPath.endsWith(".md")) {
        normalizedPath += ".md";
      }
      
      // Check if file exists
      const existingFile = app.vault.getAbstractFileByPath(normalizedPath);
      if (existingFile) {
        return {
          success: false,
          message: `File '${normalizedPath}' already exists. Please choose a different name.`,
        };
      }
      
      // Create the file
      await app.vault.create(normalizedPath, content);
      
      return {
        success: true,
        message: `File '${normalizedPath}' has been created.`,
      };
    } catch (error) {
      console.error("Error creating file:", error);
      return {
        success: false,
        message: `Failed to create file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }, [app.vault]);
  
  // Function to delete a file
  const deleteFile = useCallback(async (file: TFile) => {
    try {
      await app.vault.delete(file);
      return {
        success: true,
        message: `File '${file.path}' has been deleted.`,
      };
    } catch (error) {
      console.error("Error deleting file:", error);
      return {
        success: false,
        message: `Failed to delete file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }, [app.vault]);

  // Obsidian link click handler for accept/reject links
  useEffect(() => {
    const handleLinkClick = (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      if (target.tagName === 'A') {
        const href = target.getAttribute('href');
        if (href && href.startsWith('#accept-')) {
          evt.preventDefault();
          const changeId = href.replace('#accept-', '');
          acceptChange(changeId).then(result => {
            if (result && result.success) {
              new Notice(result.message);
            }
          });
        } else if (href && href.startsWith('#reject-')) {
          evt.preventDefault();
          const changeId = href.replace('#reject-', '');
          rejectChange(changeId).then(result => {
            if (result && result.success) {
              new Notice(result.message);
            }
          });
        }
      }
    };

    document.addEventListener('click', handleLinkClick);
    return () => {
      document.removeEventListener('click', handleLinkClick);
    };
  }, [acceptChange, rejectChange]);

  // Update the function that handles confirmations (now just processes write immediately)
  const handleConfirmOperation = useCallback(async () => {
    if (!pendingOperation) return;
    
    let result;
    
    switch (pendingOperation.type) {
      case "write":
        result = await writeToFile(pendingOperation.filename || null, pendingOperation.content);
        break;
      case "create":
        result = await createNewFile(pendingOperation.filename, pendingOperation.content);
        break;
      case "delete":
        result = await deleteFile(pendingOperation.file);
        break;
      case "remove_content":
        result = await removeContentFromFile(
          pendingOperation.filename || null,
          pendingOperation.pattern, 
          pendingOperation.startLine, 
          pendingOperation.endLine
        );
        break;
    }
    
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: result.message,
      id: generateId(),
    };
    
    setMessages(prev => [...prev, assistantMessage]);
    setPendingOperation(null);
    setAwaitingConfirmation(false);
  }, [pendingOperation, writeToFile, createNewFile, deleteFile, removeContentFromFile]);

  // Handle rejecting operations
  const handleRejectOperation = useCallback(() => {
    const operationType = pendingOperation?.type || "unknown";
    
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: `${operationType.charAt(0).toUpperCase() + operationType.slice(1)} operation cancelled.`,
      id: generateId(),
    };
    
    setMessages(prev => [...prev, assistantMessage]);
    setPendingOperation(null);
    setAwaitingConfirmation(false);
  }, [pendingOperation]);

  // Update the handleSendMessage function to handle the updated action markers
  const handleSendMessage = useCallback(async () => {
    if (!input.trim()) return;

    // Handle confirming or rejecting operations
    if (awaitingConfirmation) {
      if (input.toLowerCase().includes("yes") || input.toLowerCase().includes("confirm") || input.toLowerCase() === "y") {
        await handleConfirmOperation();
      } else {
        handleRejectOperation();
      }
      setInput("");
      return;
    }

    const userMessage: ChatMessage = {
      role: "user",
      content: input,
      id: generateId(),
    };

    // Check if this is the first user message in the session
    const isFirstUserMessage = messages.filter((msg) => msg.role === "user").length === 0;

    // Add the user message to the chat history
    setMessages((prev) => [...prev, userMessage]);

    // If it's the first user message, update the chat title
    if (isFirstUserMessage) {
      const newTitle = input.length > 20 ? input.slice(0, 20) + "..." : input;
      setChatSessions((prev) =>
        prev.map((session) =>
          session.id === currentSessionId ? { ...session, title: newTitle } : session
        )
      );
      // Update localStorage with the new title
      localStorage.setItem(
        "chat-sessions",
        JSON.stringify(
          chatSessions.map((session) =>
            session.id === currentSessionId ? { ...session, title: newTitle } : session
          )
        )
      );
    }

    setInput("");
    setIsProcessing(true);

    try {
      let fileContent = "";
      let fileName = "unknown";
      if (currentFile) {
        fileContent = await app.vault.read(currentFile);
        fileName = currentFile.name;
      }

      // Create system message with context about the current file
      let systemMessage = currentFile
        ? `You are an assistant for Obsidian. The user is currently viewing a file named "${fileName}" with the following content:\n\n${fileContent}`
        : `You are an assistant for Obsidian. The user is not currently viewing any file.`;
      
      // Add context about the assistant's capabilities to handle files
      systemMessage += `\n\nYou can assist the user with file operations such as:
- Writing content to any file in the vault
- Creating new files
- Deleting files
- Removing specific content from files

CRITICAL: You must carefully analyze the user's intent. Even when they don't use explicit keywords but imply a desire to:
- Add information to their notes
- Create a new document or file
- Remove or delete something
- Modify content in a file

You MUST interpret these as file operations and use the appropriate marker.

IMPORTANT DISTINCTIONS:
- Use [ACTION:delete] ONLY when the user wants to delete an ENTIRE file
- Use [ACTION:remove_content] when the user wants to remove SPECIFIC CONTENT within a file
- Never confuse these two operations - they serve different purposes

IMPORTANT: If your answer contains ANY content that would logically belong in a file (notes, code, outlines, etc.), ALWAYS use [ACTION:write] or [ACTION:create] markers. DO NOT simply provide the content without offering to write it to a file.

CRITICAL FOR FILENAMES: When the user requests to create a file or asks you to write to a specific file, you MUST include the filename they mentioned in your action marker. Always use the exact filename the user specifies, with the .md extension. If the user doesn't specify a filename, infer an appropriate filename from the topic.

For example:
- If user asks to create a file about recipes, use [ACTION:create filename:recipes.md]
- If user asks about React, use [ACTION:create filename:react-notes.md] or [ACTION:write filename:react-notes.md]
- If user mentions a specific filename like "meeting-notes", use exactly that: [ACTION:create filename:meeting-notes.md]

Use this format for file operations:
- For writing to a file: [ACTION:write filename:file-to-write.md]<content to write>
- For creating a new file: [ACTION:create filename:suggested-filename.md]<content for the file>
- For deleting a file: [ACTION:delete filename:filename-to-delete.md]
- For removing content: [ACTION:remove_content filename:target-file.md pattern:"text to match" startLine:X endLine:Y]

Examples of when to use these markers with filenames:
- If user says "Give me notes on functional programming" → use [ACTION:write filename:functional-programming-notes.md]
- If user says "I want to learn about React" → use [ACTION:write filename:react-notes.md]
- If user says "create a file for my meeting notes" → use [ACTION:create filename:meeting-notes.md]
- If user says "start a new file for recipes called desserts" → use [ACTION:create filename:desserts.md]
- If user says "I don't need this file anymore" → use [ACTION:delete filename:current-file.md]
- If user says "remove the part about loops" → use [ACTION:remove_content filename:current-file.md]

Place the marker at the beginning of your response, then phrase your visible response naturally, asking for confirmation. The marker itself won't be visible to the user.`;

      const history = messages
        .concat(userMessage)
        .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
        .join("\n");

      const fullPrompt = `${systemMessage}\n\n${history}\n`;

      const modelInstance = await getModel(provider, model);
      if (!modelInstance) throw new Error("Failed to load model");

      const prompt = { prefix: fullPrompt, suffix: "" };
      
      // Define tempMessageId for streaming updates
      let tempMessageId = "";
      
      // Check if the model supports streaming
      if (modelInstance.model.iterate) {
        let responseContent = "";
        const tempMessageId = generateId(); // Unique ID for temporary streaming message
        const tempMessage: ChatMessage = {
          role: "assistant",
          content: "",
          id: tempMessageId,
        };
        setMessages(prev => [...prev, tempMessage]);
      
        const stream = modelInstance.model.iterate(prompt, modelInstance.model_settings);
      
        try {
          for await (const chunk of stream) {
            responseContent += chunk;
            setMessages(prev =>
              prev.map(msg =>
                msg.id === tempMessageId ? { ...msg, content: responseContent } : msg
              )
            );
          }
        } catch (e) {
          // Handle API key errors specifically
          if (e.message?.includes("401") || e.message?.includes("invalid_api_key")) {
            const errorMessage = "API key error: The API key appears to be invalid or missing. Please check your API key in the settings.";
            setMessages(prev =>
              prev.map(msg =>
                msg.id === tempMessageId ? { ...msg, content: errorMessage } : msg
              )
            );
            setIsProcessing(false);
            return;
          }
      
          // Handle rate limit errors
          if (e.message?.includes("429") || e.message?.includes("rate_limit")) {
            const errorMessage = "Rate limit exceeded: The service is currently rate-limited. Please try again later or switch to a different model.";
            setMessages(prev =>
              prev.map(msg =>
                msg.id === tempMessageId ? { ...msg, content: errorMessage } : msg
              )
            );
            setIsProcessing(false);
            return;
          }
      
          // For other errors, continue with content received so far, or show generic error
          if (!responseContent) {
            responseContent = `Error: Unable to get a response from the model. ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      
        // Process the final response with a new unique ID
        const finalMessageId = generateId(); // Generate a new ID for the final message
        processResponse(responseContent, finalMessageId);
      
        // Remove the temporary message after processing
        setMessages(prev => prev.filter(msg => msg.id !== tempMessageId));
      } else {
        // Use regular completion API
        const response = await modelInstance.model.complete(prompt, modelInstance.model_settings);
        const responseContent = response?.toString() || "No response";
        processResponse(responseContent, userMessage.id);
      }
      
      // Process the response (extract actions, etc.)
      function processResponse(responseContent: string, messageId: string) {
        // Update the action marker regex to include optional filename in all operations
        const actionMarkerRegex = /\[ACTION:(write|create|delete|remove_content)(?:\s*filename:([^,\]]+))?(?:,?\s*pattern:([^,\]]+))?(?:,?\s*startLine:(\d+))?(?:,?\s*endLine:(\d+))?\]/i;
        const actionMatch = responseContent.match(actionMarkerRegex);
        
        // Clean the message by removing the action marker
        let cleanResponse = responseContent;
        
        // If an action is detected in the response, process it
        if (actionMatch) {
          const actionType = actionMatch[1] as "write" | "create" | "delete" | "remove_content";
          const filename = actionMatch[2]?.trim();
          const pattern = actionMatch[3]?.trim();
          const startLine = actionMatch[4] ? parseInt(actionMatch[4]) - 1 : -1; // Convert to 0-indexed
          const endLine = actionMatch[5] ? parseInt(actionMatch[5]) - 1 : -1;
          
          // Extract content (everything after the action marker)
          const markerEndIndex = responseContent.indexOf(actionMatch[0]) + actionMatch[0].length;
          let contentSection = responseContent.substring(markerEndIndex).trim();
          
          // Clean response by removing the action marker
          cleanResponse = responseContent.replace(actionMarkerRegex, '').trim();
          
          // Process different types of actions
          if (actionType === "write") {
            // Check if we have a target file (either specified or current)
            const targetFile = filename ? getFileByName(filename) : currentFile;
            
            if (!targetFile && !filename) {
              // No target file at all
              const assistantMessage: ChatMessage = {
                role: "assistant",
                content: "No active file found. Please specify a filename or open a file in Obsidian first.",
                id: messageId,
              };
              setMessages(prev => {
                // Remove temporary streaming message if it exists
                if (prev.some(msg => msg.id === tempMessageId)) {
                  return [...prev.filter(msg => msg.id !== tempMessageId), assistantMessage];
                }
                return [...prev, assistantMessage];
              });
            } else {
              // Create a pending change instead of writing immediately
              writeToFile(filename || null, contentSection).then(result => {
                // Update the pending change to associate it with this message
                if (result.success && result.changeId) {
                  setPendingChanges(prev => 
                    prev.map(change => 
                      change.id === result.changeId 
                        ? {...change, messageId} 
                        : change
                    )
                  );
                }
                
                const assistantMessage: ChatMessage = {
                  role: "assistant",
                  content: cleanResponse,
                  id: messageId,
                };
                
                setMessages(prev => {
                  // Remove temporary streaming message if it exists
                  if (prev.some(msg => msg.id === tempMessageId)) {
                    return [...prev.filter(msg => msg.id !== tempMessageId), assistantMessage];
                  }
                  return [...prev, assistantMessage];
                });
              });
            }
          } 
          else if (actionType === "create") {
            // Check if we have a suggested filename
            const suggestedFilename = filename || "new-file.md";
            
            if (contentSection.length > 0) {
              // Create a unique change ID
              const changeId = generateId();
              
              // Add to pending changes
              const newPendingChange: PendingChange = {
                id: changeId,
                fileId: suggestedFilename,
                fileName: suggestedFilename,
                content: contentSection,
                status: 'pending',
                expanded: true,
                messageId: messageId
              };
              
              setPendingChanges(prev => [...prev, newPendingChange]);
              
              const assistantMessage: ChatMessage = {
                role: "assistant",
                content: cleanResponse,
                id: messageId,
              };
              
              setMessages(prev => {
                // Remove temporary streaming message if it exists
                if (prev.some(msg => msg.id === tempMessageId)) {
                  return [...prev.filter(msg => msg.id !== tempMessageId), assistantMessage];
                }
                return [...prev, assistantMessage];
              });
            }
          } else if (actionType === "delete" || actionType === "remove_content") {
            // These operations should prompt confirmation first
            const targetFile = filename ? getFileByName(filename) : currentFile;
            if (!targetFile) {
              const assistantMessage: ChatMessage = {
                role: "assistant",
                content: `No target file found. ${filename ? `File "${filename}" not found.` : "No file is open."}`,
                id: messageId,
              };
              setMessages(prev => {
                if (prev.some(msg => msg.id === tempMessageId)) {
                  return [...prev.filter(msg => msg.id !== tempMessageId), assistantMessage];
                }
                return [...prev, assistantMessage];
              });
            } else {
              // Set awaiting confirmation and store the operation
              if (actionType === "delete") {
                setPendingOperation({
                  type: "delete",
                  file: targetFile
                });
              } else {
                setPendingOperation({
                  type: "remove_content",
                  pattern: pattern || "",
                  startLine: startLine,
                  endLine: endLine,
                  filename: filename
                });
              }
              
              setAwaitingConfirmation(true);
              
              const assistantMessage: ChatMessage = {
                role: "assistant",
                content: `${cleanResponse}\n\nWould you like me to ${actionType === "delete" ? "delete" : "remove content from"} ${targetFile.name}?`,
                id: messageId,
              };
              
              setMessages(prev => {
                if (prev.some(msg => msg.id === tempMessageId)) {
                  return [...prev.filter(msg => msg.id !== tempMessageId), assistantMessage];
                }
                return [...prev, assistantMessage];
              });
            }
          } else {
            // No recognized action type, just return the message as is
            const assistantMessage: ChatMessage = {
              role: "assistant",
              content: cleanResponse,
              id: messageId,
            };
            
            setMessages(prev => {
              if (prev.some(msg => msg.id === tempMessageId)) {
                return [...prev.filter(msg => msg.id !== tempMessageId), assistantMessage];
              }
              return [...prev, assistantMessage];
            });
          }
        }
      }
    } catch (error: any) {
      console.error("Error sending message:", error);
      new Notice(`Error: ${error.message || "Failed to get response"}`);
      const errorMessage: ChatMessage = {
        role: "assistant",
        content: "Sorry, an error occurred.",
        id: generateId(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsProcessing(false);
      inputRef.current?.focus();
    }
  }, [
    app, 
    currentFile, 
    getModel, 
    input, 
    messages, 
    model, 
    provider, 
    currentSessionId, 
    chatSessions, 
    awaitingConfirmation, 
    handleConfirmOperation, 
    handleRejectOperation,
    activeEditorRef,
    writeToFile,
    createNewFile,
    deleteFile,
    removeContentFromFile,
    getFileByName
  ]);

  // Function to toggle the visibility of pending changes for a message
  const togglePendingChangesVisibility = useCallback((messageId: string) => {
    setExpandedMessageChanges(prev => {
      if (prev.includes(messageId)) {
        return prev.filter(id => id !== messageId);
      } else {
        return [...prev, messageId];
      }
    });
  }, []);

  // Function to format message content with proper HTML
  const formatMessageContent = useCallback((content: string) => {
    if (!content) return '';
    
    // Basic markdown-like formatting
    let formatted = content;
    
    // Convert links (already in markdown format) to HTML
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      // Handle special link types
      if (url.startsWith('acceptChange:')) {
        const changeId = url.substring('acceptChange:'.length);
        return `<a href="#" onclick="window.handleAcceptChange('${changeId}'); return false;">${text}</a>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    
    // Convert code blocks
    formatted = formatted.replace(/```([a-z]*)\n([\s\S]*?)\n```/g, 
      '<pre><code>$2</code></pre>');
    
    // Convert inline code
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Convert line breaks to <br>
    formatted = formatted.replace(/\n/g, '<br>');
    
    return formatted;
  }, []);

  // Helper function to render a message with pending changes
    // Helper function to render a message with pending changes
    // In ChatView component, update renderMessage:
const renderMessage = useCallback((message: ChatMessage) => {
  const showPendingChanges = message.role === "assistant";
  const changesForMessage = showPendingChanges
    ? pendingChanges.filter(
        change =>
          change.messageId === message.id ||
          (message.content &&
            message.content.includes(`[Accept changes to ${change.fileName}](acceptChange:${change.id})`))
      )
    : [];

  return (
    <div
      key={`message-${message.id}`} // This should already be unique due to generateId
      className={`companion-chat-message companion-chat-message-${
        message.role === "user" ? "user" : "assistant"
      }`}
    >
      <div className="companion-chat-message-role">{message.role === "user" ? "You" : "Assistant"}</div>
      <div
        className="companion-chat-message-content"
        dangerouslySetInnerHTML={{ __html: formatMessageContent(message.content || "") }}
      />
      {showPendingChanges && changesForMessage.length > 0 && (
        <div className="chat-pending-changes">
          <div
            className="chat-pending-change-header"
            onClick={() => togglePendingChangesVisibility(message.id)}
          >
            <span>Pending Changes ({changesForMessage.length})</span>
            <span>{expandedMessageChanges.includes(message.id) ? "▼" : "▶"}</span>
          </div>
          {expandedMessageChanges.includes(message.id) && (
            <div>
              {changesForMessage.map((change) => {
                const targetFile = app.vault.getAbstractFileByPath(change.fileId);
                const fileExists = targetFile instanceof TFile;
                return (
                  <div
                    key={`change-${change.id}`} // Unique key for each change
                    className={`chat-pending-change chat-pending-change-${change.status}`}
                  >
                    <div className="chat-pending-change-header" onClick={() => {
                      setPendingChanges(prev =>
                        prev.map(c =>
                          c.id === change.id ? { ...c, expanded: !c.expanded } : c
                        )
                      );
                    }}>
                      <span>{change.fileName}</span>
                      <span>{change.expanded ? "▼" : "▶"}</span>
                    </div>
                    {change.expanded && (
                      <div className="chat-pending-change-content">
                        <pre>{change.content}</pre>
                      </div>
                    )}
                    {change.status === "pending" ? (
                      <div className="chat-pending-change-actions">
                        <button
                          className="chat-pending-change-accept"
                          onClick={() =>
                            fileExists
                              ? acceptChange(change.id)
                              : createNewFileFromChange(change.id)
                          }
                        >
                          Accept
                        </button>
                        <button
                          className="chat-pending-change-reject"
                          onClick={() => rejectChange(change.id)}
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <div className="chat-pending-change-status">
                        Status: {change.status}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}, [
  pendingChanges,
  expandedMessageChanges,
  togglePendingChangesVisibility,
  formatMessageContent,
  acceptChange,
  rejectChange,
  createNewFileFromChange,
  app.vault,
]);

  useEffect(() => {
    // Add CSS to the document if it doesn't already exist
    const styleId = 'companion-chat-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.innerHTML = `
        .companion-chat {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
        }
        
        .companion-chat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 16px;
          border-bottom: 1px solid var(--background-modifier-border);
        }
        
        .companion-chat-header h3 {
          margin: 0;
        }
        
        .companion-chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        
        .chat-message {
          padding: 12px;
          border-radius: 8px;
          max-width: 90%;
          width: fit-content;
        }
        
        .user-message {
          align-self: flex-end;
          background-color: var(--interactive-accent);
          color: var(--text-on-accent);
          margin-left: auto;
        }
        
        .assistant-message {
          align-self: flex-start;
          background-color: var(--background-secondary);
          border: 1px solid var(--background-modifier-border);
          color: var(--text-normal);
          margin-right: auto;
        }
        
        .message-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-weight: bold;
          color: var(--text-muted);
        }
        
        .message-content {
          white-space: pre-wrap;
          word-break: break-word;
        }
        
        .pending-changes-container {
          margin-top: 10px;
          border: 1px solid var(--background-modifier-border);
          border-radius: 4px;
          overflow: hidden;
        }
        
        .pending-changes-header {
          cursor: pointer;
          padding: 8px 10px;
          display: flex;
          justify-content: space-between;
          background-color: var(--background-secondary-alt);
          font-weight: bold;
        }
        
        .pending-changes-toggle {
          color: var(--text-muted);
        }
        
        .pending-changes-list {
          padding: 10px;
          background-color: var(--background-secondary);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .pending-change-item {
          padding: 10px;
          border: 1px solid var(--background-modifier-border);
          border-radius: 4px;
          background-color: var(--background-primary);
        }
        
        .pending-change-info {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        
        .pending-change-file {
          font-weight: bold;
        }
        
        .pending-change-status {
          display: flex;
          align-items: center;
        }
        
        .status-badge {
          padding: 2px 6px;
          border-radius: 10px;
          font-size: 0.8em;
          text-transform: uppercase;
        }
        
        .status-pending {
          background-color: var(--text-warning);
          color: var(--background-primary);
        }
        
        .status-accepted {
          background-color: var(--text-success);
          color: var(--background-primary);
        }
        
        .status-rejected {
          background-color: var(--text-error);
          color: var(--background-primary);
        }
        
        .pending-change-actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        
        .accept-change {
          background-color: var(--interactive-success);
          color: var(--text-on-accent);
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
        }
        
        .reject-change {
          background-color: var(--text-error);
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
        }
        
        .companion-chat-input {
          padding: 16px;
          border-top: 1px solid var(--background-modifier-border);
        }
        
        .companion-chat-input-container {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .companion-chat-textarea {
          width: 100%;
          min-height: 80px;
          resize: vertical;
          padding: 8px 12px;
          border-radius: 4px;
          border: 1px solid var(--background-modifier-border);
          background-color: var(--background-primary);
          color: var(--text-normal);
        }
        
        .companion-chat-actions {
          display: flex;
          justify-content: space-between;
        }
        
        .companion-chat-submit {
          background-color: var(--interactive-accent);
          color: var(--text-on-accent);
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
        }
        
        .companion-chat-submit:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        
        .companion-chat-clear {
          background-color: var(--background-modifier-border);
          color: var(--text-normal);
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
        }
      `;
      document.head.appendChild(style);
    }
  }, []);

  return (
    <div className="chat-view">
      <style>{styles}</style>
      <div className="chat-header">
        <div className="chat-file-context">
          {currentFile ? `Context: ${currentFile.name}` : "No file open"}
        </div>
        <div className="chat-model-info">
          Model: {provider} / {model}
        </div>
        <div className="chat-session-controls">
          <select
            aria-label="Chat sessions"
            value={currentSessionId || ""}
            onChange={(e) => setCurrentSessionId(e.target.value)}
          >
            {chatSessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
          <button className="chat-new-button" onClick={createNewChat}>New Chat</button>
          {chatSessions.length > 1 && (
            <button className="chat-delete-button" onClick={() => deleteChat(currentSessionId!)}>Delete Chat</button>
          )}
        </div>
      </div>

      <div className="chat-messages" ref={chatContainerRef}>
        {messages.length === 0 ? (
          <div className="chat-empty-state">Start a conversation.</div>
        ) : (
          messages.map((message) => renderMessage(message))
        )}
        {isProcessing && (
          <div className="chat-message chat-message-loading">
            <div className="chat-message-content">
              <div className="chat-loading-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}
        {awaitingConfirmation && (
          <div className="chat-message chat-message-confirmation">
            <div className="chat-confirmation-info">
              {pendingOperation?.type === "write" ? 
                `Ready to write content to ${pendingOperation.filename || currentFile?.name || "file"}` :
               pendingOperation?.type === "create" ? 
                `Ready to create file "${pendingOperation.filename}"` :
               pendingOperation?.type === "delete" ? 
                `Ready to delete file "${pendingOperation.file.name}"` :
               pendingOperation?.type === "remove_content" ? 
                `Ready to remove content from ${pendingOperation.filename || currentFile?.name || "file"}` :
                "Ready to proceed"}
            </div>
            <div className="chat-confirmation-buttons">
              <button className="chat-confirm-button" onClick={handleConfirmOperation}>
                {pendingOperation?.type === "write" ? "Write to File" :
                pendingOperation?.type === "create" ? "Create File" :
                pendingOperation?.type === "delete" ? "Delete File" :
                pendingOperation?.type === "remove_content" ? "Remove Content" :
                "Proceed"}
              </button>
              <button className="chat-cancel-button" onClick={handleRejectOperation}>Cancel</button>
            </div>
          </div>
        )}
        {/* Add Accept All button when there are pending changes */}
        {pendingChanges.some(change => change.status === 'pending') && (
          <div className="companion-chat-accept-all-container">
            <button 
              className="companion-chat-accept-all-button"
              onClick={() => {
                acceptAllChanges().then(result => {
                  if (result && result.success) {
                    new Notice(result.message);
                  }
                });
              }}
            >
              Accept All Changes
            </button>
            <button 
              className="companion-chat-reject-all-button"
              onClick={() => {
                rejectAllChanges().then(result => {
                  if (result && result.success) {
                    new Notice(result.message);
                  }
                });
              }}
            >
              Reject All Changes
            </button>
          </div>
        )}
      </div>

      <div className="chat-input-container">
        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
          />
          <button
            className="chat-send-button"
            onClick={handleSendMessage}
            disabled={!input.trim() || isProcessing}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};