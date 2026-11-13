// Embeddable chat widget. Usage on any site:
//   <script type="module" src="widget.js" data-kb="knowledge.json" data-webhook="https://..."></script>
import { createAssistant } from "./engine.js";

const LEADS_KEY = "chat-assistant-leads";

export function loadLeads() {
  try {
    return JSON.parse(localStorage.getItem(LEADS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLead(lead) {
  try {
    const all = loadLeads();
    all.unshift(lead);
    localStorage.setItem(LEADS_KEY, JSON.stringify(all.slice(0, 50)));
  } catch {
    /* storage unavailable: the webhook still receives the lead */
  }
  window.dispatchEvent(new CustomEvent("chat-lead", { detail: lead }));
}

export function clearLeads() {
  try {
    localStorage.removeItem(LEADS_KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent("chat-lead"));
}

export async function mountWidget({ kbUrl, webhook, open = false } = {}) {
  const kb = await fetch(kbUrl).then((r) => r.json());
  const sessionId = Math.random().toString(36).slice(2);
  const assistant = createAssistant(kb, {
    onLead: (lead) => {
      saveLead(lead);
      // Google Sheets (Apps Script), Make, n8n or Zapier webhook.
      if (webhook) fetch(webhook, { method: "POST", mode: "no-cors", body: JSON.stringify(lead) }).catch(() => {});
    },
  });

  const root = document.createElement("div");
  root.className = "cw";
  root.innerHTML = `
    <button class="cw-launch" aria-label="Open chat"><span class="dot"></span>Ask us anything</button>
    <section class="cw-panel" role="dialog" aria-label="Chat with ${kb.business.name}">
      <header class="cw-head">
        <div><strong>${kb.business.name}</strong><span>Answers instantly · team on WhatsApp</span></div>
        <button class="cw-close" aria-label="Close chat">×</button>
      </header>
      <div class="cw-log" aria-live="polite"></div>
      <div class="cw-chips"></div>
      <form class="cw-form">
        <input class="cw-input" placeholder="Ask about tables, menu, hours…" autocomplete="off" aria-label="Message" />
        <button class="cw-send">Send</button>
      </form>
      <div class="cw-foot">Answers come from the restaurant's own information</div>
    </section>`;
  document.body.appendChild(root);

  const log = root.querySelector(".cw-log");
  const chips = root.querySelector(".cw-chips");
  const input = root.querySelector(".cw-input");

  function bubble(text, who, meta) {
    const el = document.createElement("div");
    el.className = `cw-msg cw-${who}`;
    el.textContent = text;
    if (meta) {
      const m = document.createElement("small");
      m.textContent = meta;
      el.appendChild(m);
    }
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function setChips(list = []) {
    chips.innerHTML = "";
    for (const c of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c;
      b.onclick = () => send(c);
      chips.appendChild(b);
    }
  }

  function send(text) {
    if (!text.trim()) return;
    bubble(text, "user");
    setChips();
    const typing = document.createElement("div");
    typing.className = "cw-msg cw-bot cw-typing";
    typing.innerHTML = "<i></i><i></i><i></i>";
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    setTimeout(() => {
      typing.remove();
      const r = assistant.reply(sessionId, text);
      let meta = "";
      if (r.source) meta = `Source: FAQ “${r.source}”`;
      if (r.lead) meta = r.lead.type === "booking" ? "✓ Booking request sent to the team" : "✓ Passed to the team";
      if (r.guarded) meta = "Guardrail: off-topic request blocked";
      bubble(r.text, "bot", meta);
      setChips(r.suggestions);
    }, 450);
  }

  root.querySelector(".cw-form").onsubmit = (e) => {
    e.preventDefault();
    send(input.value);
    input.value = "";
  };
  const toggle = (state) => {
    if (state === undefined) state = !root.classList.contains("cw-open");
    root.classList.toggle("cw-open", state);
    if (state && matchMedia("(min-width: 521px)").matches) input.focus();
  };
  root.querySelector(".cw-launch").onclick = () => toggle();
  root.querySelector(".cw-close").onclick = () => toggle(false);

  bubble(`Hello! I can answer questions about ${kb.business.name}, book you a table, or pass you to the team.`, "bot");
  setChips(["Book a table", "Are you open on Monday?", "Vegan options?", "Talk to a person"]);
  if (open) toggle(true);

  return { send, kb, open: () => toggle(true) };
}

// Auto-mount when loaded with data attributes.
const me = document.currentScript || document.querySelector("script[data-kb]");
if (me && me.dataset && me.dataset.kb) mountWidget({ kbUrl: me.dataset.kb, webhook: me.dataset.webhook });
