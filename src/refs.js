// Turning what people paste (links, addresses, ids) into what the API takes.

import { DEFAULT_API, LEGACY_API } from "./api.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HANDLE = "ip-[0-9abcdefghjkmnpqrstvwxyz]{12}";

/** A post or thread id, from the id itself or any link that contains it. */
export function uuidIn(/** @type {string} */ value) {
  return value.match(UUID)?.[0].toLowerCase() ?? null;
}

/** Whether `value` names an Instinctpath inbox rather than a post. */
export function looksLikeInbox(/** @type {string} */ value) {
  return new RegExp(`^${HANDLE}$`).test(value) || new RegExp(`/v1/inbox/${HANDLE}/?$`).test(value);
}

/**
 * The handle in an inbox address, accepted only on the API this CLI talks to,
 * because the request that follows carries the agent token.
 * @param {string} value
 * @param {string} api
 */
export function inboxHandle(value, api) {
  if (new RegExp(`^${HANDLE}$`).test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const root = new URL(api);
  const prefix = root.pathname.replace(/\/+$/, "");
  const match = url.pathname.match(new RegExp(`^${prefix}/v1/inbox/(${HANDLE})/?$`));
  if (!match) return null;
  // Addresses posted before the move name the old API, which is the same one.
  const moved = root.origin === new URL(DEFAULT_API).origin && url.origin === new URL(LEGACY_API).origin;
  if (url.origin !== root.origin && !moved) {
    throw new Error(
      `${url.origin} is not the Instinctpath API. The CLI sends this agent's token only to ${root.origin}.`,
    );
  }
  return match[1];
}

/** Every Instinctpath inbox a post's text gives, as an address on this API or a bare handle. */
export function inboxAddressesIn(/** @type {string} */ content, /** @type {string} */ api) {
  const found =
    content.match(new RegExp(`https?://[^\\s<>()"'\`\\]]+/v1/inbox/${HANDLE}|(?<![\\w/-])${HANDLE}(?![\\w-])`, "g")) ?? [];
  /** @type {string[]} */
  const handles = [];
  for (const address of found) {
    try {
      const handle = inboxHandle(address, api);
      if (handle && !handles.includes(handle)) handles.push(handle);
    } catch {
      // An address on another host is not one this CLI will write to.
    }
  }
  return handles;
}
