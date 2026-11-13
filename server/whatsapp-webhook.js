// WhatsApp Business (Cloud API) webhook running the same assistant as the website widget.
//
//   WHATSAPP_TOKEN=...          permanent access token from Meta
//   WHATSAPP_PHONE_ID=...       phone number ID from the WhatsApp app dashboard
//   WHATSAPP_VERIFY_TOKEN=...   any string; paste the same into Meta's webhook settings
//   LEAD_WEBHOOK=...            optional: Google Sheets / n8n / Make URL that receives leads
//   ANTHROPIC_API_KEY=...       optional: natural-language replies via Claude
//
//   npm install && npm run whatsapp
import http from "node:http";
import { readFileSync } from "node:fs";
import { createAssistant } from "../src/engine.js";
import { groundedReply, llmEnabled } from "./llm.js";

const kb = JSON.parse(readFileSync(new URL("../data/knowledge.json", import.meta.url)));
const { WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN, LEAD_WEBHOOK, PORT = 3000 } = process.env;

const assistant = createAssistant(kb, {
  onLead: async (lead) => {
    console.log("New lead", lead.type, lead.name, lead.contact);
    if (LEAD_WEBHOOK) {
      await fetch(LEAD_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lead) }).catch((e) =>
        console.error("Lead webhook failed", e.message)
      );
    }
  },
});

async function sendWhatsApp(to, text) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) console.error("WhatsApp send failed", res.status, await res.text());
}

export async function handleIncoming(from, text) {
  let reply = assistant.reply(from, text);
  // Only FAQ answers are rephrased; booking steps, hand-offs and guardrails stay deterministic.
  if (reply.source && llmEnabled()) {
    const better = await groundedReply(kb, text);
    if (better) reply = { ...reply, text: better.text };
  }
  return reply;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Meta verifies the webhook with a GET request once.
  if (req.method === "GET" && url.pathname === "/webhook") {
    const ok = url.searchParams.get("hub.verify_token") === WHATSAPP_VERIFY_TOKEN;
    res.writeHead(ok ? 200 : 403).end(ok ? url.searchParams.get("hub.challenge") : "forbidden");
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.writeHead(200).end("ok"); // acknowledge fast, Meta retries slow webhooks
    try {
      const msgs = JSON.parse(body).entry?.flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []) ?? [];
      for (const m of msgs) {
        if (m.type !== "text") {
          await sendWhatsApp(m.from, "I can read text messages only. Could you type your question?");
          continue;
        }
        const reply = await handleIncoming(m.from, m.text.body);
        await sendWhatsApp(m.from, reply.text);
      }
    } catch (e) {
      console.error("Bad webhook payload", e.message);
    }
    return;
  }

  res.writeHead(404).end();
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`WhatsApp webhook on :${PORT} (LLM ${llmEnabled() ? "on" : "off"})`));
}
