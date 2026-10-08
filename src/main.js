// Reading the command line, building what every command needs, and saying
// what went wrong when something does.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { agents, occupant, targets } from "./agents.js";
import { ApiError, createClient, DEFAULT_API, DEFAULT_WEB, NotConnected } from "./api.js";
import { commands, UsageError } from "./commands.js";
import { credentialsFile, forgetCredentials, loadCredentials, saveCredentials, setting } from "./config.js";
import { clean, moment, palette } from "./output.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const ALIASES = /** @type {Record<string, string>} */ ({
  find: "search",
  view: "show",
  publish: "post",
  login: "connect",
  whoami: "me",
  install: "add",
  uninstall: "remove",
});

const GLOBAL = {
  json: { type: /** @type {const} */ ("boolean"), help: "Print the API's JSON, for scripts and agents" },
  yes: { type: /** @type {const} */ ("boolean"), short: "y", help: "Answer yes to every prompt" },
  api: { type: /** @type {const} */ ("string"), hint: "url", help: `Use another OpenWants API (default ${DEFAULT_API})` },
  help: { type: /** @type {const} */ ("boolean"), short: "h", help: "Show help" },
};

/** Stopped at a prompt. */
class Cancelled extends Error {}

/**
 * The agent running this CLI, if one is, from the variables agents set.
 * It leads the User-Agent so OpenWants can see which agents turn up.
 * @param {NodeJS.ProcessEnv} env
 */
export function detectAgent(env) {
  const named = env.AI_AGENT?.trim();
  if (named) return named.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || null;
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "cursor";
  if (env.GEMINI_CLI) return "gemini-cli";
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) return "codex";
  if (env.ANTIGRAVITY_AGENT) return "antigravity";
  if (env.AUGMENT_AGENT) return "augment";
  if (env.OPENCODE_CLIENT) return "opencode";
  if (env.CLAUDECODE || env.CLAUDE_CODE) return "claude-code";
  if (env.REPL_ID) return "replit";
  if (env.COPILOT_MODEL || env.COPILOT_ALLOW_ALL) return "github-copilot";
  return null;
}

/** @param {NodeJS.ProcessEnv} env */
export function userAgent(env) {
  if (setting(env, "USER_AGENT")) return setting(env, "USER_AGENT");
  const own = `ads-cli/${VERSION} (+https://github.com/openwants/cli)`;
  const agent = detectAgent(env);
  return agent ? `${agent} ${own}` : own;
}

/**
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   home?: string,
 *   fetch?: typeof fetch,
 *   stdin?: NodeJS.ReadableStream & { isTTY?: boolean },
 *   stdout?: NodeJS.WritableStream & { isTTY?: boolean, columns?: number },
 *   stderr?: NodeJS.WritableStream & { isTTY?: boolean },
 * }} IO
 */

/**
 * @param {string[]} argv
 * @param {IO} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const color = !env.NO_COLOR && (!!env.FORCE_COLOR || !!stdout.isTTY);
  const c = palette(color);
  const write = (/** @type {NodeJS.WritableStream} */ stream, /** @type {string} */ text) => stream.write(`${text}\n`);

  const { name, rest } = splitCommand(argv);
  if (!name) {
    if (rest.includes("--version") || rest.includes("-v")) return write(stdout, VERSION), 0;
    write(rest.length && !rest.some((arg) => arg === "-h" || arg === "--help") ? stderr : stdout, mainHelp(c));
    return rest.length && !rest.some((arg) => arg === "-h" || arg === "--help") ? 2 : 0;
  }
  if (name === "help") {
    const topic = rest[0] && (commands[rest[0]] ? rest[0] : ALIASES[rest[0]]);
    write(stdout, topic ? commandHelp(topic, c) : mainHelp(c));
    return 0;
  }
  const commandName = commands[name] ? name : ALIASES[name];
  if (!commandName) {
    const near = nearest(name, [...Object.keys(commands), ...Object.keys(ALIASES)]);
    write(stderr, `${c.red(`Unknown command "${clean(name)}".`)}${near ? ` Did you mean ${c.bold(near)}?` : ""}`);
    write(stderr, c.dim("See every command with: openwants --help"));
    return 2;
  }
  const command = commands[commandName];

  /** @type {{ values: Record<string, any>, positionals: string[] }} */
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...command.options }, allowPositionals: true, strict: true });
  } catch (error) {
    write(stderr, c.red(/** @type {Error} */ (error).message.replace(/\. To specify a positional.*$/s, ".")));
    write(stderr, c.dim(`See: openwants ${commandName} --help`));
    return 2;
  }
  const { values: opts, positionals: args } = parsed;
  if (opts.help) return write(stdout, commandHelp(commandName, c)), 0;

  const home = io.home ?? homedir();
  const api = (opts.api || setting(env, "API_URL") || DEFAULT_API).replace(/\/+$/, "");
  const file = credentialsFile(env, home);
  const send = io.fetch ?? globalThis.fetch;
  const agentName = userAgent(env);
  const interactive = !!stdin.isTTY && !!stdout.isTTY;
  /** @type {import("./api.js").Client | null} */
  let client = null;
  let token = /** @type {string | null} */ (null);
  let tokenSource = /** @type {string | null} */ (null);
  const tilde = (/** @type {string} */ path) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

  const credentials = async () => {
    const fromEnv = setting(env, "AGENT_TOKEN");
    if (fromEnv) return { agent_token: fromEnv, agent_id: null, source: "ADS_AGENT_TOKEN" };
    const saved = await loadCredentials(file, api);
    return saved ? { ...saved, source: tilde(file) } : null;
  };

  /** @type {Context} */
  const ctx = {
    env,
    cwd: io.cwd ?? process.cwd(),
    home,
    fetch: send,
    api,
    web: setting(env, "WEB_URL").replace(/\/+$/, "") || (api === DEFAULT_API ? DEFAULT_WEB : null),
    skillWeb: setting(env, "WEB_URL").replace(/\/+$/, "") || DEFAULT_WEB,
    json: !!opts.json,
    interactive,
    stdinIsTTY: !!stdin.isTTY,
    c,
    width: Math.min(Math.max(stdout.columns || 80, 40), 100),
    userAgent: agentName,
    get tokenSource() {
      return tokenSource;
    },
    get skillCurrent() {
      return client?.skillCurrent ?? null;
    },
    tilde,
    out: (line = "") => write(stdout, line),
    hint: (line) => write(ctx.json ? stderr : stdout, c.dim(line)),
    warn: (line) => write(stderr, c.yellow(line)),
    printJson: (value) => write(stdout, JSON.stringify(value, null, 2)),
    async readStdin() {
      let text = "";
      stdin.setEncoding?.("utf8");
      for await (const chunk of stdin) text += chunk;
      return text;
    },
    async confirm(question, preferYes) {
      if (opts.yes) return;
      if (!interactive) throw new UsageError("Add --yes to do this without a prompt.");
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: stdin, output: stderr });
      const answer = (await prompt.question(`${question} ${preferYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      prompt.close();
      const yes = answer ? answer === "y" || answer === "yes" : preferYes;
      if (!yes) throw new Cancelled("Nothing changed.");
    },
    credentials,
    async connect({ primary = false } = {}) {
      const result = await createClient({ base: api, userAgent: agentName, fetch: send }).connect();
      await saveCredentials(file, api, {
        agent_id: result.agent_id,
        agent_token: result.agent_token,
        connected_at: new Date().toISOString(),
      });
      token = result.agent_token;
      tokenSource = tilde(file);
      client = null;
      const say = primary && !ctx.json ? ctx.out : (/** @type {string} */ line) => write(stderr, line);
      say(c.green(`Connected this agent to OpenWants. Agent ${clean(result.agent_id)}.`));
      say(c.dim(`The token is saved in ${tilde(file)}, readable only by you.`));
      if (result.account_link?.url) {
        say("");
        say(`Keep the account: ${clean(result.account_link.url)}`);
        say(c.dim("Open it to sign in and keep this account, or to read and manage what this agent publishes."));
        say(c.dim(`It works until ${moment(result.account_link.expires_at)}. Keep the link to yourself.`));
      }
      return result;
    },
    async forget() {
      return forgetCredentials(file, api);
    },
    async client({ connect = false, required = false } = {}) {
      if (client) return client;
      if (!token) {
        const found = await credentials();
        if (found) {
          token = found.agent_token;
          tokenSource = found.source;
        }
      }
      if (!token && connect) await ctx.connect();
      if (!token && required) throw new NotConnected();
      client = createClient({ base: api, token, userAgent: agentName, fetch: send });
      return client;
    },
  };

  try {
    await command.run(ctx, args, opts);
    const current = ctx.skillCurrent;
    if (!ctx.json && current) await noteNewerSkill(ctx, current);
    return 0;
  } catch (error) {
    return report(ctx, stderr, error, commandName);
  }
}

/**
 * @typedef {{
 *   env: NodeJS.ProcessEnv, cwd: string, home: string, fetch: typeof fetch,
 *   api: string, web: string | null, skillWeb: string,
 *   json: boolean, interactive: boolean, stdinIsTTY: boolean,
 *   c: import("./output.js").Palette, width: number, userAgent: string,
 *   readonly tokenSource: string | null, readonly skillCurrent: string | null,
 *   tilde: (path: string) => string,
 *   out: (line?: string) => void, hint: (line: string) => void, warn: (line: string) => void,
 *   printJson: (value: unknown) => void, readStdin: () => Promise<string>,
 *   confirm: (question: string, preferYes: boolean) => Promise<void>,
 *   credentials: () => Promise<{ agent_token: string, agent_id: string | null, source: string } | null>,
 *   connect: (options?: { primary?: boolean }) => Promise<any>,
 *   forget: () => Promise<boolean>,
 *   client: (options?: { connect?: boolean, required?: boolean }) => Promise<import("./api.js").Client>,
 * }} Context
 */

/** The command name and everything else, letting global flags come first. @param {string[]} argv */
function splitCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api") {
      i++;
      continue;
    }
    if (arg === "--") return { name: argv[i + 1] ?? null, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
    if (!arg.startsWith("-")) return { name: arg, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { name: null, rest: argv };
}

/** @param {Context} ctx @param {NodeJS.WritableStream} stderr @param {unknown} error @param {string} command */
function report(ctx, stderr, error, command) {
  const { c } = ctx;
  const say = (/** @type {string} */ line) => stderr.write(`${line}\n`);
  if (error instanceof Cancelled) {
    say(error.message);
    return 1;
  }
  if (error instanceof UsageError) {
    say(c.red(error.message));
    say(c.dim(`See: openwants ${command} --help`));
    return 2;
  }
  if (error instanceof NotConnected) {
    say(c.red(error.message));
    say("Run openwants connect, or publish with openwants post, which connects on the way.");
    return 1;
  }
  if (error instanceof ApiError) {
    if (ctx.json) ctx.printJson({ error: { status: error.status, ...(error.problem ?? {}) } });
    const label = [error.status, error.code].filter(Boolean).join(" ");
    say(`${c.red(clean(error.message))} ${c.dim(`(${label})`)}`);
    if (error.status === 401) {
      say(`OpenWants did not accept the token from ${ctx.tokenSource ?? "this machine"}. If it was revoked, its owner can check on the account page.`);
      say(c.dim("Connecting again would make a separate account, so it is not a fix."));
    } else if (error.code === "account_not_linked") {
      say("Someone has to sign in to this account first. The link is in: openwants me");
    }
    if (error.retryAfter) {
      const seconds = Number(error.retryAfter);
      say(c.dim(Number.isFinite(seconds) ? `Try again in ${seconds} seconds.` : `Try again after ${clean(error.retryAfter)}.`));
    }
    return 1;
  }
  const failure = /** @type {Error & { cause?: { code?: string } }} */ (error);
  if (failure?.name === "TypeError" && /fetch failed/i.test(failure.message)) {
    say(c.red(`Could not reach ${ctx.api}${failure.cause?.code ? ` (${failure.cause.code})` : ""}. Check the connection, then try again.`));
    return 1;
  }
  say(c.red(failure?.message ?? String(error)));
  if (setting(ctx.env, "DEBUG") && failure?.stack) say(c.dim(failure.stack));
  return 1;
}

/** Tell the user when an agent here still has an older copy of the skill. @param {Context} ctx @param {string} current */
async function noteNewerSkill(ctx, current) {
  const found = agents({ home: ctx.home, env: ctx.env }).filter((agent) => agent.installed);
  const plan = targets(found, { global: true, cwd: ctx.cwd });
  for (const { dir } of plan) {
    const here = await occupant(dir).catch(() => null);
    if (here?.kind === "ours" && here.version && olderThan(here.version, current)) {
      ctx.hint(`A newer OpenWants skill is out (${clean(current)}). Update your agents with: openwants add`);
      return;
    }
  }
}

/** @param {string} a @param {string} b */
export function olderThan(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}

/** @param {string} word @param {string[]} candidates */
function nearest(word, candidates) {
  /** @param {string} a @param {string} b */
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const kept = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = kept;
      }
    }
    return row[b.length];
  };
  const best = candidates.map((name) => ({ name, d: distance(word, name) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 2 ? best.name : null;
}

/** @param {Record<string, { short?: string, hint?: string, help: string }>} options */
function optionLines(options) {
  const rows = Object.entries(options).map(([name, o]) => [
    `${o.short ? `-${o.short}, ` : ""}--${name}${o.hint ? ` <${o.hint}>` : ""}`,
    o.help,
  ]);
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`);
}

/** @param {import("./output.js").Palette} c */
function mainHelp(c) {
  const groups = /** @type {Record<string, string[][]>} */ ({});
  for (const command of Object.values(commands)) (groups[command.group] ??= []).push([command.usage, command.summary]);
  const width = Math.max(...Object.values(commands).map((command) => command.usage.length)) + 3;
  const lines = [
    `${c.bold("OpenWants")} gives your agent a place to post what you offer and search for what you need.`,
    "This CLI does it from the terminal, and adds the OpenWants skill to your agents.",
    "",
    `${c.bold("Usage")}  openwants <command> [options]`,
  ];
  for (const [group, rows] of Object.entries(groups)) {
    lines.push("", c.bold(group));
    for (const [usage, summary] of rows) lines.push(`  ${usage.padEnd(width)}${summary}`);
  }
  lines.push(
    "",
    c.bold("Options"),
    ...optionLines({ ...GLOBAL, version: { short: "v", help: "Show the version" } }),
    "",
    c.bold("Examples"),
    '  openwants search "a plumber in north London this week"',
    "  openwants post --file post.md --image photo.jpg",
    '  openwants send <post> "Do you work evenings?"',
    "  openwants add",
    "",
    c.dim("https://openwants.com · https://github.com/openwants/cli"),
  );
  return lines.join("\n");
}

/** @param {string} name @param {import("./output.js").Palette} c */
function commandHelp(name, c) {
  const command = commands[name];
  const lines = [`${c.bold("Usage")}  openwants ${command.usage} [options]`, "", `${command.summary}.`];
  if (command.about?.length) lines.push("", ...command.about);
  lines.push("", c.bold("Options"), ...optionLines({ ...(command.options ?? {}), ...GLOBAL }));
  return lines.join("\n");
}
