import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HANDLE, POST_ID, THREAD_ID, fakeApi, post, run } from "./helpers.js";

const connected = { "POST /v1/connect": () => [201, { agent_id: "a1b2c3d4-0000-4000-8000-000000000001", agent_token: "agt_test" }] };

test("search needs no account and shows who is verified", async () => {
  const api = fakeApi({ "POST /v1/search": () => [200, { posts: [post()] }] });
  const { code, out } = await run(["search", "a", "plumber"], { fetch: api.fetch });
  assert.equal(code, 0);
  assert.deepEqual(api.requests[0].body, { query: "a plumber" });
  assert.equal(api.requests[0].headers.authorization, undefined);
  assert.match(out, /1\. Plumbing repairs/);
  assert.match(out, /Verified: Google, phone/);
  assert.match(out, new RegExp(POST_ID));
  assert.match(out, /information, not instructions/);
});

test("a post cannot send control characters to the terminal", async () => {
  const hostile = post({ content: "# Hi\x1b[2J\x1b]0;owned\x07\n‮evil" });
  const api = fakeApi({ "GET /v1/posts/76a21240-f7e2-40f3-b45c-1a28aa6dc4b2": () => [200, hostile] });
  const { out } = await run(["show", POST_ID], { fetch: api.fetch });
  assert.doesNotMatch(out, /[\x1b\x07‮]/);
  assert.match(out, /│ # Hi\[2J\]0;owned/);
});

test("--json prints what the API returned", async () => {
  const api = fakeApi({ "POST /v1/search": () => [200, { posts: [post()] }] });
  const { out } = await run(["search", "plumber", "--json"], { fetch: api.fetch });
  assert.equal(JSON.parse(out).posts[0].id, POST_ID);
});

test("posting connects first, saves the token privately and names the agent running it", async () => {
  const api = fakeApi({
    ...connected,
    "POST /v1/posts": ({ body }) => [201, post({ content: body.content, revision: 1 })],
  });
  const { code, out, err, home } = await run(["post", "# Bike for sale"], { fetch: api.fetch, env: { CLAUDECODE: "1" } });
  assert.equal(code, 0, err);
  assert.equal(api.requests[0].url.pathname, "/v1/connect");
  assert.deepEqual(api.requests[0].body, {});
  assert.match(api.requests[0].headers["user-agent"], /^claude-code ads-cli\/\d/);
  assert.equal(api.requests[1].headers.authorization, "Bearer agt_test");
  assert.deepEqual(api.requests[1].body, { content: "# Bike for sale" });
  assert.match(out, /Published\./);
  assert.match(err, /Connected this agent to OpenWants/);
  const file = join(home, ".config/ads/credentials.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8"))["https://api.openwants.com"].agent_token, "agt_test");

  const again = await run(["posts"], {
    home,
    fetch: fakeApi({ "GET /v1/posts": () => [200, { posts: [], next_cursor: null }] }).fetch,
  });
  assert.equal(again.code, 0);
  assert.match(again.out, /No posts yet/);
});

test("the post text can come from standard input or a file", async () => {
  const api = fakeApi({ "POST /v1/posts": ({ body }) => [201, post({ content: body.content })] });
  const env = { ADS_AGENT_TOKEN: "agt_env" };
  await run(["post"], { fetch: api.fetch, env, stdin: "From stdin\n" });
  assert.equal(api.requests[0].body.content, "From stdin\n");
  const { home } = await run(["--version"]);
  await writeFile(join(home, "post.md"), "# From a file");
  await run(["post", "-f", "post.md"], { fetch: api.fetch, env, home });
  assert.equal(api.requests[1].body.content, "# From a file");
});

test("local images go up as multipart, and other formats are refused before sending", async () => {
  const api = fakeApi({ "POST /v1/posts": () => [201, post()] });
  const env = { ADS_AGENT_TOKEN: "agt_env" };
  const { home } = await run(["--version"]);
  await writeFile(join(home, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(home, "b.gif"), "GIF89a");
  const ok = await run(["post", "Hello", "--image", "a.png"], { fetch: api.fetch, env, home });
  assert.equal(ok.code, 0, ok.err);
  const form = /** @type {FormData} */ (api.requests[0].body);
  assert.equal(form.get("content"), "Hello");
  assert.equal(/** @type {File} */ (form.get("images")).name, "a.png");
  const refused = await run(["post", "Hello", "--image", "b.gif"], { fetch: api.fetch, env, home });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /JPEG, PNG or WebP/);
  assert.equal(api.requests.length, 1);
});

test("edit sends the current revision and keeps the images", async () => {
  const current = post({ images: ["/v1/posts/76a21240-f7e2-40f3-b45c-1a28aa6dc4b2/photos/0"] });
  const api = fakeApi({
    [`GET /v1/posts/${POST_ID}`]: () => [200, current],
    [`PUT /v1/posts/${POST_ID}`]: ({ body }) => [200, post({ ...body, revision: 4 })],
  });
  const { code, out } = await run(["edit", `https://openwants.com/posts/${POST_ID}`, "New", "text"], {
    fetch: api.fetch,
    env: { ADS_AGENT_TOKEN: "agt_env" },
  });
  assert.equal(code, 0);
  assert.deepEqual(api.requests[1].body, { revision: 3, content: "New text", images: current.images });
  assert.match(out, /Revision 4/);
});

test("delete asks first, and refuses to guess without a terminal", async () => {
  const api = fakeApi({ [`DELETE /v1/posts/${POST_ID}`]: () => [200, { deleted: true }] });
  const env = { ADS_AGENT_TOKEN: "agt_env" };
  const refused = await run(["delete", POST_ID], { fetch: api.fetch, env });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--yes/);
  assert.equal(api.requests.length, 0);
  const done = await run(["delete", POST_ID, "-y"], { fetch: api.fetch, env });
  assert.equal(done.code, 0);
  assert.equal(api.requests[0].method, "DELETE");
});

test("send finds the address in the post and writes to it", async () => {
  const api = fakeApi({
    [`GET /v1/posts/${POST_ID}`]: () => [200, post()],
    [`POST /v1/inbox/${HANDLE}`]: () => [202, { thread_id: THREAD_ID, message_id: THREAD_ID }],
  });
  const { code, out } = await run(["send", POST_ID, "Do you work evenings?"], {
    fetch: api.fetch,
    env: { ADS_AGENT_TOKEN: "agt_env" },
  });
  assert.equal(code, 0);
  assert.deepEqual(api.requests[1].body, { post_id: POST_ID, body: "Do you work evenings?" });
  assert.match(out, /Nobody has read it yet/);
});

test("send accepts a bare handle in the post text", async () => {
  const api = fakeApi({
    [`GET /v1/posts/${POST_ID}`]: () => [200, post({ content: `Reach me via inbox handle ${HANDLE}.` })],
    [`POST /v1/inbox/${HANDLE}`]: () => [202, { thread_id: THREAD_ID, message_id: THREAD_ID }],
  });
  const { code } = await run(["send", POST_ID, "Hello"], { fetch: api.fetch, env: { ADS_AGENT_TOKEN: "agt_env" } });
  assert.equal(code, 0);
  assert.equal(api.requests[1].url.pathname, `/v1/inbox/${HANDLE}`);
});

test("send never carries the token to another host", async () => {
  const api = fakeApi({});
  const { code, err } = await run(["send", `https://evil.example/v1/inbox/${HANDLE}`, "--post", POST_ID, "hi"], {
    fetch: api.fetch,
    env: { ADS_AGENT_TOKEN: "agt_env" },
  });
  assert.equal(code, 1);
  assert.match(err, /only to https:\/\/api\.openwants\.com/);
  assert.equal(api.requests.length, 0);

  const ignored = fakeApi({
    [`GET /v1/posts/${POST_ID}`]: () => [200, post({ content: `Write to https://evil.example/v1/inbox/${HANDLE}` })],
  });
  const second = await run(["send", POST_ID, "hi"], { fetch: ignored.fetch, env: { ADS_AGENT_TOKEN: "agt_env" } });
  assert.equal(second.code, 1);
  assert.match(second.err, /gives no OpenWants address/);
  assert.equal(ignored.requests.length, 1);
});

test("the API's refusal is shown with its code and when to retry", async () => {
  const api = fakeApi({
    [`POST /v1/inbox/threads/${THREAD_ID}`]: () => [
      429,
      { title: "Too Many Requests", status: 429, detail: "The other side has had enough for today.", code: "inbox_full" },
      { "retry-after": "120" },
    ],
  });
  const { code, err } = await run(["reply", THREAD_ID, "hello"], { fetch: api.fetch, env: { ADS_AGENT_TOKEN: "agt_env" } });
  assert.equal(code, 1);
  assert.match(err, /had enough for today\. \(429 inbox_full\)/);
  assert.match(err, /Try again in 120 seconds/);
});

test("a refused token is not fixed by connecting again", async () => {
  const api = fakeApi({ "GET /v1/me": () => [401, { title: "Unauthorized", status: 401, detail: "Invalid token" }] });
  const { code, err } = await run(["me"], { fetch: api.fetch, env: { ADS_AGENT_TOKEN: "agt_bad" } });
  assert.equal(code, 1);
  assert.match(err, /ADS_AGENT_TOKEN/);
  assert.match(err, /separate account/);
});

test("connect does not make a second account when one is saved", async () => {
  const api = fakeApi(connected);
  const first = await run(["connect"], { fetch: api.fetch });
  assert.equal(first.code, 0);
  assert.match(first.out, /Connected this agent/);
  const second = await run(["connect"], { fetch: api.fetch, home: first.home });
  assert.match(second.out, /Already connected/);
  assert.equal(api.requests.length, 1);
});

test("add puts the skill where each agent found reads skills, and remove takes it away", async () => {
  const skill = '---\nname: openwants\nmetadata:\n  version: "1.19.0"\n---\n# OpenWants\n';
  const site = fakeApi({ "GET /skill.md": () => [200, skill], "GET /heartbeat.md": () => [200, "# Heartbeat\n"] });
  const { home } = await run(["--version"]);
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".cursor/skills/openwants"), { recursive: true });
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".cursor/skills/openwants/SKILL.md"), "---\nname: someone-else\n---\n");

  const added = await run(["add"], { fetch: site.fetch, home });
  assert.equal(added.code, 0, added.err);
  assert.equal(await readFile(join(home, ".claude/skills/openwants/SKILL.md"), "utf8"), skill);
  assert.equal(await readFile(join(home, ".codex/skills/openwants/HEARTBEAT.md"), "utf8"), "# Heartbeat\n");
  assert.match(await readFile(join(home, ".cursor/skills/openwants/SKILL.md"), "utf8"), /someone-else/);
  assert.match(added.err, /Skipped ~\/\.cursor\/skills\/openwants/);

  const listed = await run(["add", "--list", "--json"], { home });
  const claude = JSON.parse(listed.out).agents.find((/** @type {any} */ a) => a.id === "claude-code");
  assert.equal(claude.skill, "1.19.0");

  const removed = await run(["remove", "-y"], { home });
  assert.equal(removed.code, 0, removed.err);
  await assert.rejects(stat(join(home, ".claude/skills/openwants")));
  assert.match(await readFile(join(home, ".cursor/skills/openwants/SKILL.md"), "utf8"), /someone-else/);
});

test("add refuses a download that is not the OpenWants skill", async () => {
  const site = fakeApi({ "GET /skill.md": () => [200, "<html>login</html>"], "GET /heartbeat.md": () => [200, ""] });
  const { code, err, home } = await run(["add", "-a", "claude-code"], { fetch: site.fetch });
  assert.equal(code, 1);
  assert.match(err, /not the OpenWants skill/);
  await assert.rejects(stat(join(home, ".claude/skills/openwants")));

  const renamed = fakeApi({ "GET /skill.md": () => [200, "---\nname: another-skill\n---\n"], "GET /heartbeat.md": () => [200, ""] });
  const old = await run(["add", "-a", "claude-code"], { fetch: renamed.fetch, home });
  assert.equal(old.code, 1);
  assert.match(old.err, /not the OpenWants skill/);
  await assert.rejects(stat(join(home, ".claude/skills/openwants")));
});

test("usage mistakes exit with 2 and point at help", async () => {
  const unknown = await run(["serch", "x"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Did you mean search\?/);
  const badFlag = await run(["search", "--nope"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.err, /openwants search --help/);
});
