// Where this machine keeps the agent token OpenAd issued on connect.
// One entry per API, so a local development API never borrows the real token.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A setting under its current name, `OPENAD_<NAME>`, or the one it had before
 * the rename, `INSTAPATH_<NAME>`. Empty when neither is set.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
export function setting(env, name) {
  return env[`OPENAD_${name}`]?.trim() || env[`INSTAPATH_${name}`]?.trim() || "";
}

/**
 * @typedef {{ agent_id: string, agent_token: string, connected_at: string }} Credentials
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function configDir(env, home) {
  const chosen = setting(env, "CONFIG_DIR");
  if (chosen) return chosen;
  if (process.platform === "win32" && env.APPDATA?.trim()) return join(env.APPDATA.trim(), "openad");
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "openad");
}

/** @param {NodeJS.ProcessEnv} env @param {string} home */
export function credentialsFile(env, home) {
  return join(configDir(env, home), "credentials.json");
}

/** @param {string} file @returns {Promise<Record<string, Credentials>>} */
async function readAll(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return adoptEarlierFile(file);
    throw new Error(`Could not read ${file}. Fix or delete it, then try again.`);
  }
}

/**
 * Tokens saved before the rename sit in `.../instapath/credentials.json`. The
 * first read moves them next to where the new name keeps them, so a token is
 * never kept in two places.
 * @param {string} file
 * @returns {Promise<Record<string, Credentials>>}
 */
async function adoptEarlierFile(file) {
  const earlier = file.replace(/openad([\\/]credentials\.json)$/, "instapath$1");
  if (earlier === file) return {};
  let parsed;
  try {
    parsed = JSON.parse(await readFile(earlier, "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  await writeAll(file, parsed);
  await rm(earlier, { force: true });
  return parsed;
}

/** @param {string} file @param {Record<string, Credentials>} all */
async function writeAll(file, all) {
  const dir = join(file, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** @param {string} file @param {string} api @returns {Promise<Credentials | null>} */
export async function loadCredentials(file, api) {
  const entry = (await readAll(file))[api];
  return entry?.agent_token ? entry : null;
}

/** @param {string} file @param {string} api @param {Credentials} credentials */
export async function saveCredentials(file, api, credentials) {
  const all = await readAll(file);
  all[api] = credentials;
  await writeAll(file, all);
}

/** @param {string} file @param {string} api */
export async function forgetCredentials(file, api) {
  const all = await readAll(file);
  if (!all[api]) return false;
  delete all[api];
  if (Object.keys(all).length) await writeAll(file, all);
  else await rm(file, { force: true });
  return true;
}
