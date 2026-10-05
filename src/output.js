// How posts, conversations and accounts read in a terminal.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const PROOFS = /** @type {Record<string, string>} */ ({
  apple_account: "Apple",
  facebook_account: "Facebook",
  github_account: "GitHub",
  google_account: "Google",
  linkedin_account: "LinkedIn",
  payment_card: "card",
  government_id: "ID",
  phone_number: "phone",
  company_domain: "company domain",
});

/**
 * Posts and messages are written by strangers. Drop every control character
 * but newline and tab, and the invisible direction marks, so a post cannot
 * move the cursor, recolour the screen or reorder what a reader sees.
 */
export function clean(/** @type {unknown} */ text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "");
}

/** @param {boolean} enabled */
export function palette(enabled) {
  const wrap = (/** @type {number} */ open, /** @type {number} */ close) =>
    enabled ? (/** @type {unknown} */ s) => `\x1b[${open}m${s}\x1b[${close}m` : (/** @type {unknown} */ s) => String(s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
  };
}

/** @typedef {ReturnType<typeof palette>} Palette */

/** Cut to `width` characters, counting what a person sees. */
export function fit(/** @type {string} */ text, /** @type {number} */ width) {
  const chars = Array.from(text);
  return chars.length <= width ? text : `${chars.slice(0, Math.max(width - 1, 1)).join("")}…`;
}

/** `4 Oct 2026` */
export function day(/** @type {string | null | undefined} */ iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** `4 Oct 14:05` */
export function moment(/** @type {string | null | undefined} */ iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

/** `2026-03` as `Mar 2026` */
export function month(/** @type {string | undefined} */ since) {
  const [year, number] = String(since ?? "").split("-").map(Number);
  return year && number ? `${MONTHS[number - 1]} ${year}` : clean(since);
}

/**
 * What Instapath has checked about whoever wrote a post, in the words the
 * website uses: a company domain, the accounts they verified, or nothing.
 * @param {any} integrity
 */
export function verified(integrity) {
  if (!integrity) return "Not verified";
  const domains = (integrity.domains ?? []).map(clean);
  if (domains.length) return `Verified ${domains[0]}${domains.length > 1 ? ` +${domains.length - 1}` : ""}`;
  const proofs = (integrity.proofs ?? []).filter((/** @type {string} */ p) => p !== "company_domain");
  if (proofs.length) return `Verified: ${proofs.map((/** @type {string} */ p) => PROOFS[p] ?? clean(p)).join(", ")}`;
  return "Not verified";
}

/** @param {any} integrity @param {Palette} c */
export function trust(integrity, c) {
  const label = verified(integrity);
  return label === "Not verified" ? c.yellow(label) : c.green(label);
}

/** Every fact about an author, one a line, for a post read in full. @param {any} integrity */
export function aboutAuthor(integrity) {
  if (!integrity) return [];
  const lines = [];
  for (const domain of integrity.domains ?? []) lines.push(`Controls ${clean(domain)}, a company domain`);
  for (const proof of integrity.proofs ?? []) {
    if (proof === "company_domain" && integrity.domains?.length) continue;
    lines.push(`Verified ${PROOFS[proof] ?? clean(proof)}`);
  }
  if (!lines.length) lines.push("Has not verified an account, phone, card, ID or domain");
  if (integrity.since) lines.push(`On Instapath since ${month(integrity.since)}`);
  if (typeof integrity.posts === "number") lines.push(`${integrity.posts} live ${integrity.posts === 1 ? "post" : "posts"}`);
  return lines;
}

/** The first line of a post as its title, and the next few as a preview. @param {string} content */
export function summary(content) {
  const lines = clean(content)
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  return { title: lines[0] ?? "(empty post)", preview: lines.slice(1).join(" ") };
}

/** A text block set off with a rule, wrapped to `width`, so it reads as quoted. @param {string} text @param {Palette} c @param {number} width */
export function quoted(text, c, width) {
  return clean(text)
    .split("\n")
    .flatMap((line) => (line ? wrap(line, width - 2) : [""]))
    .map((line) => `${c.dim("│")} ${line}`);
}

/** Wrap words to `width`, breaking a word only when it is longer than a line. @param {string} text @param {number} width */
export function wrap(text, width) {
  const words = text.split(" ").flatMap((word) => {
    const chars = Array.from(word);
    if (chars.length <= width) return [word];
    const pieces = [];
    for (let i = 0; i < chars.length; i += width) pieces.push(chars.slice(i, i + width).join(""));
    return pieces;
  });
  /** @type {string[]} */
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && Array.from(`${line} ${word}`).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
