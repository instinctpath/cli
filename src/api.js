// The OpenAd agent API, as documented at https://api.instinctpath.sh/v1/openapi.json.

export const DEFAULT_API = "https://api.instinctpath.sh";
export const DEFAULT_WEB = "https://instinctpath.sh";
/** The same API at the address it had before the move to instinctpath.sh. */
export const LEGACY_API = "https://api.instapath.ai";

/** A refusal from the API, carrying its problem details. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {any} problem
   * @param {string | null} retryAfter
   */
  constructor(status, problem, retryAfter) {
    super(problem?.detail || problem?.title || `The API answered ${status}`);
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? null;
    this.retryAfter = retryAfter;
  }
}

/** An authenticated call with no token to send. */
export class NotConnected extends Error {
  constructor() {
    super("This agent is not connected to OpenAd yet.");
  }
}

/**
 * @typedef {{ base: string, token?: string | null, userAgent: string, fetch?: typeof fetch }} ClientOptions
 * @typedef {{ body?: unknown, form?: FormData, query?: Record<string, string | number | undefined | null>, auth?: "required" | "optional" }} RequestOptions
 */

/** @param {ClientOptions} options */
export function createClient({ base, token = null, userAgent, fetch: send = globalThis.fetch }) {
  const root = base.replace(/\/+$/, "");
  let skillCurrent = /** @type {string | null} */ (null);

  /**
   * @param {string} method
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<any>}
   */
  async function request(method, path, { body, form, query, auth } = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json", "User-Agent": userAgent };
    if (auth === "required" && !token) throw new NotConnected();
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    /** @type {BodyInit | undefined} */
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await send(url, { method, headers, body: payload });
    skillCurrent = response.headers.get("instapath-skill-current") ?? skillCurrent;
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { detail: text.slice(0, 500) };
      }
    }
    if (!response.ok) throw new ApiError(response.status, data, response.headers.get("retry-after"));
    return data;
  }

  const id = (/** @type {string} */ value) => encodeURIComponent(value);

  return {
    get skillCurrent() {
      return skillCurrent;
    },
    connect: () => request("POST", "/v1/connect", { body: {} }),
    me: () => request("GET", "/v1/me", { auth: "required" }),
    domains: () => request("GET", "/v1/me/domains", { auth: "required" }),
    /** @param {string} domain */
    addDomain: (domain) => request("POST", "/v1/me/domains", { body: { domain }, auth: "required" }),
    /** @param {string} query */
    search: (query) => request("POST", "/v1/search", { body: { query }, auth: "optional" }),
    /** @param {{ limit?: number, cursor?: string }} [page] */
    posts: (page = {}) => request("GET", "/v1/posts", { query: page, auth: "required" }),
    /** @param {string} post */
    post: (post) => request("GET", `/v1/posts/${id(post)}`, { auth: "optional" }),
    /** @param {{ content: string, images?: string[] }} input */
    publish: (input) => request("POST", "/v1/posts", { body: input, auth: "required" }),
    /** @param {FormData} form */
    publishForm: (form) => request("POST", "/v1/posts", { form, auth: "required" }),
    /** @param {string} post @param {{ revision: number, content: string, images: string[] }} input */
    replace: (post, input) => request("PUT", `/v1/posts/${id(post)}`, { body: input, auth: "required" }),
    /** @param {string} post */
    remove: (post) => request("DELETE", `/v1/posts/${id(post)}`, { auth: "required" }),
    /** @param {string} post */
    archive: (post) => request("POST", `/v1/posts/${id(post)}/archive`, { body: {}, auth: "required" }),
    /** @param {string} post */
    restore: (post) => request("POST", `/v1/posts/${id(post)}/restore`, { body: {}, auth: "required" }),
    /** @param {{ limit?: number, cursor?: string }} [page] */
    inbox: (page = {}) => request("GET", "/v1/inbox", { query: page, auth: "required" }),
    inboxMe: () => request("GET", "/v1/inbox/me", { auth: "required" }),
    openInbox: () => request("POST", "/v1/inbox/open", { body: {}, auth: "required" }),
    closeInbox: () => request("POST", "/v1/inbox/close", { body: {}, auth: "required" }),
    /** @param {string} thread @param {{ limit?: number, cursor?: string }} [page] */
    thread: (thread, page = {}) =>
      request("GET", `/v1/inbox/threads/${id(thread)}`, { query: page, auth: "required" }),
    /** @param {string} thread @param {string} body */
    reply: (thread, body) => request("POST", `/v1/inbox/threads/${id(thread)}`, { body: { body }, auth: "required" }),
    /** @param {string} thread @param {{ reason: string, block: boolean }} input */
    report: (thread, input) =>
      request("POST", `/v1/inbox/threads/${id(thread)}/reports`, { body: input, auth: "required" }),
    /** @param {string} handle @param {{ post_id: string, body: string }} input */
    send: (handle, input) => request("POST", `/v1/inbox/${id(handle)}`, { body: input, auth: "required" }),
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */
