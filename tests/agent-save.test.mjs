import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

test("save and test uses the committed credential, and reports saved state on provider failure", async () => {
  const source = await readFile("app/api/admin/agent-control/route.ts", "utf8");
  const id = "00000000-0000-4000-8000-000000000001";
  const events = [];
  let fail = false;
  class ApiError extends Error {}
  const modules = {
    "next/server": { NextResponse: { json: (body) => body } },
    zod: { z },
    "@/config/experiment": { experiment: { id: "experiment" } },
    "@/lib/admin-auth": { assertSameOrigin() {}, getAuthenticatedAdmin: async () => ({ id: "admin" }) },
    "@/lib/http": { ApiError, errorResponse: (error) => { throw error; } },
    "@/lib/agent-test-error": { formatAgentTestFailure: () => "认证失败" },
    "@/lib/agent-control": {
      saveAgentConfig: async (input) => {
        events.push("commit");
        assert.equal(input.token, "new-token");
        return { id, baseUrl: input.baseUrl, botId: input.botId };
      },
      resolveAgentTestConnection: async (input) => {
        events.push("read");
        assert.equal(input.id, id);
        assert.equal(input.token, undefined);
        return { token: "database-token" };
      },
      getAgentControl: async () => ({ agents: [{ id }] }),
    },
    "@/lib/coze": { testCozeConnection: async (input) => {
      events.push("test");
      assert.equal(input.token, "database-token");
      if (fail) throw new Error("provider failure");
    } },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URL, Error, require: (name) => modules[name] });
  const request = { json: async () => ({
    action: "save_agent", testAfterSave: true,
    agent: { id, internalName: "test", baseUrl: "https://api.coze.cn", botId: "123", token: "new-token", enabled: true },
  }) };
  const success = await exports.POST(request);
  assert.deepEqual(events, ["commit", "read", "test"]);
  assert.equal(success.test.ok, true);
  fail = true;
  const failure = await exports.POST(request);
  assert.equal(failure.test.ok, false);
  assert.match(failure.test.message, /配置已保存/);
  assert.equal(failure.control.agents[0].id, id);
});
