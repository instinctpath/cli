import assert from "node:assert/strict";
import { test } from "node:test";
import { skillName, skillVersion } from "../src/agents.js";
import { detectAgent, olderThan } from "../src/main.js";
import { clean, summary, verified, wrap } from "../src/output.js";
import { inboxAddressesIn, inboxHandle, uuidIn } from "../src/refs.js";

const API = "https://api.openad.sh";

test("ids come out of links", () => {
  assert.equal(uuidIn("https://instinctpath.sh/posts/76A21240-F7E2-40F3-B45C-1A28AA6DC4B2"), "76a21240-f7e2-40f3-b45c-1a28aa6dc4b2");
  assert.equal(uuidIn("not an id"), null);
});

test("inbox addresses are accepted on the API host only", () => {
  assert.equal(inboxHandle("ip-4k7m9qxr2ht3", API), "ip-4k7m9qxr2ht3");
  assert.equal(inboxHandle(`${API}/v1/inbox/ip-4k7m9qxr2ht3`, API), "ip-4k7m9qxr2ht3");
  assert.throws(() => inboxHandle("https://api.openad.sh.evil.example/v1/inbox/ip-4k7m9qxr2ht3", API));
  assert.equal(inboxHandle("ip-4k7m9qxr2hti", API), null, "i is not in the handle alphabet");
  // Addresses written before the moves name the same API.
  assert.equal(inboxHandle("https://api.instinctpath.sh/v1/inbox/ip-4k7m9qxr2ht3", API), "ip-4k7m9qxr2ht3");
  assert.equal(inboxHandle("https://api.instapath.ai/v1/inbox/ip-4k7m9qxr2ht3", API), "ip-4k7m9qxr2ht3");
  assert.throws(() => inboxHandle("https://api.instapath.ai/v1/inbox/ip-4k7m9qxr2ht3", "https://api.example.test"));
  assert.deepEqual(
    inboxAddressesIn(`Write to ${API}/v1/inbox/ip-4k7m9qxr2ht3 or ip-4k7m9qxr2ht3, not x-ip-aaaaaaaaaaaa`, API),
    ["ip-4k7m9qxr2ht3"],
  );
});

test("verification reads the way the website says it", () => {
  assert.equal(verified({ proofs: [], domains: [] }), "Not verified");
  assert.equal(verified({ proofs: ["google_account", "phone_number"], domains: [] }), "Verified: Google, phone");
  assert.equal(verified({ proofs: ["company_domain"], domains: ["acme.com", "acme.org"] }), "Verified acme.com +1");
});

test("a summary takes the first line as the title", () => {
  assert.deepEqual(summary("# Plumbing **repairs**\n\nI fix [sinks](https://x.example)."), {
    title: "Plumbing repairs",
    preview: "I fix sinks.",
  });
  assert.equal(clean("a\x1b[31mb\r\nc"), "a[31mb\nc");
  assert.deepEqual(wrap("aaaa bbbb cccc", 9), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("the agent running the CLI is named from its environment", () => {
  assert.equal(detectAgent({ CLAUDECODE: "1" }), "claude-code");
  assert.equal(detectAgent({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectAgent({ AI_AGENT: "My Agent/2" }), "My-Agent-2");
  assert.equal(detectAgent({}), null);
});

test("skill versions compare as numbers", () => {
  assert.equal(olderThan("1.9.0", "1.12.0"), true);
  assert.equal(olderThan("1.12.0", "1.12.0"), false);
  assert.equal(skillName('---\nname: "openad"\n---\n'), "openad");
  assert.equal(skillVersion('---\nname: openad\nmetadata:\n  version: "1.19.0"\n---\n'), "1.19.0");
});
