/**
 * Compaction Context Recovery Plugin
 * 
 * Preserves recent conversation context across compaction cycles:
 * 1. before_compaction: Captures last N messages from session JSONL → RECENT.md
 * 2. before_agent_start: If compaction just happened, injects RECENT.md as prependContext
 * 
 * This ensures the agent has continuity after context compaction.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";

interface PluginConfig {
  messageCount?: number;
  maxCharsPerMessage?: number;
}

interface PluginApi {
  config: {
    plugins?: {
      entries?: {
        "compaction-context"?: {
          config?: PluginConfig;
        };
      };
    };
    agents?: {
      defaults?: {
        workspace?: string;
      };
    };
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  registerHook: (name: string, handler: (...args: unknown[]) => unknown) => void;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}

const FLAG_FILE = ".compaction-recovery-pending";
const RECENT_FILE = "RECENT.md";

function getConfig(api: PluginApi): PluginConfig {
  return api.config.plugins?.entries?.["compaction-context"]?.config ?? {};
}

function getWorkspaceDir(api: PluginApi, ctx: AgentContext): string {
  return ctx.workspaceDir ?? api.config.agents?.defaults?.workspace ?? join(process.env.HOME ?? "", ".openclaw/workspace");
}

function getSessionsDir(agentId: string): string {
  return join(process.env.HOME ?? "", ".openclaw/agents", agentId, "sessions");
}

function findLatestSessionFile(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  
  const files = readdirSync(sessionsDir)
    .filter(f => f.endsWith(".jsonl") && !f.includes("sessions.json"))
    .map(f => ({
      name: f,
      path: join(sessionsDir, f),
      mtime: statSync(join(sessionsDir, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);
  
  return files.length > 0 ? files[0].path : null;
}

function extractRecentMessages(
  sessionFile: string,
  messageCount: number,
  maxChars: number
): string[] {
  const content = readFileSync(sessionFile, "utf-8");
  const lines = content.trim().split("\n");
  
  const messages: string[] = [];
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.role === "user" || entry.role === "assistant") {
        let text = "";
        if (typeof entry.content === "string") {
          text = entry.content;
        } else if (Array.isArray(entry.content)) {
          // Handle content blocks
          text = entry.content
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("\n");
        }
        
        if (text) {
          const truncated = text.length > maxChars 
            ? text.slice(0, maxChars) + "..." 
            : text;
          messages.push(`**${entry.role}**: ${truncated}`);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  
  // Return last N messages
  return messages.slice(-messageCount);
}

function writeRecentContext(workspaceDir: string, messages: string[]): void {
  const content = `# Recent Context (Pre-Compaction Snapshot)

*This file was auto-generated before compaction. It contains the last ${messages.length} messages for context continuity.*

---

${messages.join("\n\n")}
`;
  
  writeFileSync(join(workspaceDir, RECENT_FILE), content, "utf-8");
}

function setFlag(workspaceDir: string): void {
  writeFileSync(join(workspaceDir, FLAG_FILE), new Date().toISOString(), "utf-8");
}

function checkAndClearFlag(workspaceDir: string): boolean {
  const flagPath = join(workspaceDir, FLAG_FILE);
  if (existsSync(flagPath)) {
    unlinkSync(flagPath);
    return true;
  }
  return false;
}

function readRecentContext(workspaceDir: string): string | null {
  const recentPath = join(workspaceDir, RECENT_FILE);
  if (existsSync(recentPath)) {
    return readFileSync(recentPath, "utf-8");
  }
  return null;
}

export default function register(api: PluginApi) {
  const config = getConfig(api);
  const messageCount = config.messageCount ?? 20;
  const maxChars = config.maxCharsPerMessage ?? 500;

  api.logger.info(`[compaction-context] Registered (preserving ${messageCount} messages)`);

  // Before compaction: capture recent messages
  api.registerHook("before_compaction", (_event: unknown, ctx: AgentContext) => {
    try {
      const workspaceDir = getWorkspaceDir(api, ctx);
      const agentId = ctx.agentId ?? "main";
      
      api.logger.info(`[compaction-context] Compaction starting for ${agentId}, capturing context...`);
      
      const sessionsDir = getSessionsDir(agentId);
      const sessionFile = findLatestSessionFile(sessionsDir);
      
      if (!sessionFile) {
        api.logger.warn(`[compaction-context] No session file found for ${agentId}`);
        return;
      }
      
      const messages = extractRecentMessages(sessionFile, messageCount, maxChars);
      
      if (messages.length === 0) {
        api.logger.warn(`[compaction-context] No messages extracted from session`);
        return;
      }
      
      writeRecentContext(workspaceDir, messages);
      setFlag(workspaceDir);
      
      api.logger.info(`[compaction-context] Captured ${messages.length} messages to RECENT.md`);
    } catch (err) {
      api.logger.error(`[compaction-context] Failed to capture context: ${err}`);
    }
  });

  // Before agent start: inject context if we just compacted
  api.registerHook("before_agent_start", (_event: unknown, ctx: AgentContext) => {
    try {
      const workspaceDir = getWorkspaceDir(api, ctx);
      
      if (!checkAndClearFlag(workspaceDir)) {
        // No compaction happened, nothing to inject
        return;
      }
      
      const recentContext = readRecentContext(workspaceDir);
      
      if (!recentContext) {
        api.logger.warn(`[compaction-context] Flag was set but RECENT.md not found`);
        return;
      }
      
      api.logger.info(`[compaction-context] Injecting recent context after compaction`);
      
      return {
        prependContext: `\n\n<compaction_context_recovery>\n${recentContext}\n</compaction_context_recovery>\n\n`
      };
    } catch (err) {
      api.logger.error(`[compaction-context] Failed to inject context: ${err}`);
      return;
    }
  });
}
