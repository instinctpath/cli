// Where each agent reads skills from, and adding or removing the OpenWants
// skill there. The folders follow the open skills ecosystem, so a copy added
// here sits exactly where `npx skills add` would put it.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SKILL = "openwants";

/**
 * @typedef {{ id: string, name: string, project: string, global: string, installed: boolean }} Agent
 * @param {{ home: string, env: NodeJS.ProcessEnv }} where
 * @returns {Agent[]}
 */
export function agents({ home, env }) {
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const claude = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const codex = env.CODEX_HOME?.trim() || join(home, ".codex");
  const hermes = env.HERMES_HOME?.trim() || join(home, ".hermes");
  const claw = [".openclaw", ".clawdbot", ".moltbot"].map((dir) => join(home, dir)).find((dir) => existsSync(dir));
  /** @type {[string, string, string, string, string | false][]} id, name, project folder, global folder, what shows it is installed */
  const table = [
    ["claude-code", "Claude Code", ".claude/skills", join(claude, "skills"), claude],
    ["codex", "Codex", ".agents/skills", join(codex, "skills"), codex],
    ["cursor", "Cursor", ".agents/skills", join(home, ".cursor/skills"), join(home, ".cursor")],
    ["gemini-cli", "Gemini CLI", ".agents/skills", join(home, ".gemini/skills"), join(home, ".gemini")],
    ["github-copilot", "GitHub Copilot", ".agents/skills", join(home, ".copilot/skills"), join(home, ".copilot")],
    ["opencode", "OpenCode", ".agents/skills", join(config, "opencode/skills"), join(config, "opencode")],
    ["openclaw", "OpenClaw", "skills", join(claw ?? join(home, ".openclaw"), "skills"), claw ?? false],
    ["hermes-agent", "Hermes Agent", ".hermes/skills", join(hermes, "skills"), hermes],
    ["amp", "Amp", ".agents/skills", join(config, "agents/skills"), join(config, "amp")],
    ["cline", "Cline", ".agents/skills", join(home, ".agents/skills"), join(home, ".cline")],
    ["goose", "Goose", ".goose/skills", join(config, "goose/skills"), join(config, "goose")],
    ["junie", "Junie", ".junie/skills", join(home, ".junie/skills"), join(home, ".junie")],
    ["kiro-cli", "Kiro CLI", ".kiro/skills", join(home, ".kiro/skills"), join(home, ".kiro")],
    ["roo", "Roo Code", ".roo/skills", join(home, ".roo/skills"), join(home, ".roo")],
    ["trae", "Trae", ".trae/skills", join(home, ".trae/skills"), join(home, ".trae")],
    ["warp", "Warp", ".agents/skills", join(home, ".agents/skills"), join(home, ".warp")],
    ["windsurf", "Windsurf", ".windsurf/skills", join(home, ".codeium/windsurf/skills"), join(home, ".codeium/windsurf")],
    ["universal", "Any agent that reads .agents/skills", ".agents/skills", join(config, "agents/skills"), false],
  ];
  return table.map(([id, name, project, global, marker]) => ({
    id,
    name,
    project,
    global,
    installed: marker ? existsSync(marker) : false,
  }));
}

/**
 * The agents to add the skill for: those named with --agent, or every agent
 * found on this machine, or the shared .agents folder when none is found.
 * @param {Agent[]} all
 * @param {string[]} requested
 */
export function chooseAgents(all, requested) {
  if (requested.includes("*")) return all;
  if (requested.length) {
    const unknown = requested.filter((id) => !all.some((agent) => agent.id === id));
    if (unknown.length) {
      throw new Error(`Unknown agent: ${unknown.join(", ")}. Known agents: ${all.map((a) => a.id).join(", ")}`);
    }
    return all.filter((agent) => requested.includes(agent.id));
  }
  const found = all.filter((agent) => agent.installed);
  return found.length ? found : all.filter((agent) => agent.id === "universal");
}

/**
 * Each skill folder once, with every agent that reads it.
 * @param {Agent[]} chosen
 * @param {{ global: boolean, cwd: string }} scope
 */
export function targets(chosen, { global, cwd }) {
  /** @type {Map<string, string[]>} */
  const byDir = new Map();
  for (const agent of chosen) {
    const dir = join(global ? agent.global : join(cwd, agent.project), SKILL);
    byDir.set(dir, [...(byDir.get(dir) ?? []), agent.name]);
  }
  return [...byDir].map(([dir, names]) => ({ dir, names }));
}

/** The `name:` in a SKILL.md's frontmatter. @param {string} text */
export function skillName(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return front?.[1].match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? null;
}

/** The `version:` in a SKILL.md's metadata. @param {string} text */
export function skillVersion(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return front?.[1].match(/^\s+version:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? null;
}

/** What is in a skill folder now: nothing, our skill, or somebody else's. @param {string} dir */
export async function occupant(dir) {
  let text;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return existsSync(dir) ? { kind: /** @type {const} */ ("other"), version: null } : { kind: /** @type {const} */ ("none"), version: null };
  }
  const name = skillName(text);
  return name === SKILL
    ? { kind: /** @type {const} */ ("ours"), version: skillVersion(text) }
    : { kind: /** @type {const} */ ("other"), version: null };
}

/** @param {string} dir @param {Record<string, string>} files */
export async function writeSkill(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}

/** @param {string} dir */
export async function removeSkill(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * The skill as OpenWants publishes it now.
 * @param {string} web
 * @param {{ fetch: typeof fetch, userAgent: string }} io
 */
export async function downloadSkill(web, { fetch: send, userAgent }) {
  const root = web.replace(/\/+$/, "");
  /** @type {Record<string, string>} */
  const files = {};
  for (const [name, path] of [
    ["SKILL.md", "/skill.md"],
    ["HEARTBEAT.md", "/heartbeat.md"],
  ]) {
    const response = await send(root + path, { headers: { "User-Agent": userAgent, Accept: "text/markdown" } });
    if (!response.ok) throw new Error(`Could not download ${root}${path} (${response.status}).`);
    files[name] = await response.text();
  }
  if (skillName(files["SKILL.md"]) !== SKILL) {
    throw new Error(`${root}/skill.md is not the OpenWants skill. Nothing was written.`);
  }
  return { files, version: skillVersion(files["SKILL.md"]) };
}
