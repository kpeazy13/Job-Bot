import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSelection } from "../src/ai.ts";
const evidence = [
  {
    id: "approved",
    title: "Role",
    bullet: "Verified contribution",
    skills: ["Testing"],
    source: "user",
    approved: true as const,
  },
];
test("AI cannot select invented or repeated evidence IDs", () => {
  assert.throws(() =>
    validateSelection(
      {
        selected_bullet_ids: ["invented"],
        priority_keywords: [],
        unsupported_keywords: [],
      },
      evidence,
    ),
  );
  assert.throws(() =>
    validateSelection(
      {
        selected_bullet_ids: ["approved", "approved"],
        priority_keywords: [],
        unsupported_keywords: [],
      },
      evidence,
    ),
  );
  assert.deepEqual(
    validateSelection(
      {
        selected_bullet_ids: ["approved"],
        priority_keywords: ["Testing"],
        unsupported_keywords: ["Rust"],
      },
      evidence,
    ).selected_bullet_ids,
    ["approved"],
  );
});
