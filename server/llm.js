// Optional LLM layer. The rule engine picks the relevant FAQ entries; Claude
// only rewrites them into a natural reply in the customer's language. It is
// told to answer from those entries alone and to hand off otherwise, so it
// can't invent prices or opening hours.
//
// Enabled when ANTHROPIC_API_KEY is set. Without it, replies come straight
// from the FAQ file, which is what the GitHub Pages demo does.
import Anthropic from "@anthropic-ai/sdk";
import { rank } from "../src/engine.js";

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function llmEnabled() {
  return Boolean(client);
}

/**
 * Returns a natural-language reply grounded in the business's FAQs, or null to
 * keep the rule-based reply (no key set, nothing relevant, or the model asked
 * for a hand-off).
 */
export async function groundedReply(kb, message) {
  if (!client) return null;
  const context = rank(message, kb.faqs).slice(0, 3);
  if (context.length === 0) return null;

  const facts = context.map((r) => `- ${r.faq.q}\n  ${r.faq.a}`).join("\n");
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system:
        `You are the customer assistant for ${kb.business.name}, a ${kb.business.type}. ` +
        "Answer the customer using only the facts provided. Reply in the customer's language, " +
        "in at most three short sentences, friendly and plain. If the facts don't answer the " +
        "question, reply with exactly HANDOFF and nothing else.",
      messages: [{ role: "user", content: `Facts:\n${facts}\n\nCustomer message: ${message}` }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text || text === "HANDOFF") return null;
    return { text, source: context[0].faq.id };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn("LLM rate limited; using FAQ answer");
    else if (err instanceof Anthropic.APIError) console.warn(`LLM error ${err.status}; using FAQ answer`);
    else throw err;
    return null;
  }
}
