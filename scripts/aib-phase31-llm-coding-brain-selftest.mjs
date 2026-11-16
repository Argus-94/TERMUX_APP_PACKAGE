import assert from "node:assert/strict";

function parse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = fenced?.[1]?.trim() || (() => { const a=text.indexOf("{"); const b=text.lastIndexOf("}"); if(a<0||b<=a) throw new Error("LLM_CODING_JSON_NOT_FOUND"); return text.slice(a,b+1); })();
  const raw = JSON.parse(source);
  if (!raw || typeof raw !== "object" || typeof raw.summary !== "string" || !Array.isArray(raw.edits)) throw new Error("LLM_CODING_PLAN_INVALID");
  for (const e of raw.edits) if (!e || typeof e.path !== "string" || typeof e.content !== "string") throw new Error("LLM_CODING_EDIT_INVALID");
  return raw;
}
assert.equal(parse('{"summary":"ok","edits":[{"path":"src/a.ts","content":"export const x=1;"}]}').edits.length, 1);
assert.equal(parse('```json\n{"summary":"repair","edits":[]}\n```').summary, "repair");
assert.throws(() => parse("not json"), /LLM_CODING_JSON_NOT_FOUND/);
assert.throws(() => parse('{"summary":"x","edits":[{"path":1,"content":"x"}]}'), /LLM_CODING_EDIT_INVALID/);
console.log("AIB_PHASE31_LLM_CODING_BRAIN_SELFTEST_OK");
