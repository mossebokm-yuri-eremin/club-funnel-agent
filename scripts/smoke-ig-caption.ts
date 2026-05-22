import { generateIgCaption, extractIgShortcode } from "../src/services/ig-caption-generator.js";
import { pool, closePool } from "../src/db/client.js";

(async () => {
  // Берём свежую approved idea (или любую с pain_tag/strategy/summary)
  const r = await pool.query<{ id: string; summary: string; pain_tag: string; strategy: "A"|"B"|"C" }>(
    "SELECT id, summary, pain_tag, strategy FROM ideas WHERE strategy IS NOT NULL AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  );
  const idea = r.rows[0];
  if (!idea) { console.log("no ideas"); return; }
  console.log("idea:", JSON.stringify(idea));
  const result = await generateIgCaption({
    ideaSummary: idea.summary,
    painTag: idea.pain_tag ?? "",
    strategy: idea.strategy,
    codeWord: "test_code_2026",
  });
  console.log("\n=== CAPTION ===\n" + result.caption);
  console.log("\nchars=" + result.caption.length + "  costUsd=" + result.costUsd);
  console.log("\n=== shortcode tests ===");
  for (const u of [
    "https://www.instagram.com/p/CxAbc123def/",
    "https://instagram.com/reel/Dyy_-456hijk?utm=ig_web",
    "https://example.com/foo",
  ]) {
    console.log(u + " → " + extractIgShortcode(u));
  }
  process.exit(0);
})().catch((e) => { console.error("FAIL:", (e as Error).message); process.exit(1); }).finally(() => closePool());
