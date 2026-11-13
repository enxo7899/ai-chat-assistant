// Grounded FAQ assistant engine.
// Runs unchanged in the browser widget, the WhatsApp webhook and the tests.
// It only answers from the business's own knowledge base; anything it is not
// sure about goes to a person instead of being guessed.

const STOPWORDS = new Set(
  "a an the is are am do does did you your we our i me my to of in on at for and or can could would will what which who how when where there here it its be with any have has this that from please hi hello".split(" ")
);

export function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function tokenize(text) {
  return normalise(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/** Score every FAQ against a message. Returns [{faq, score}] best first. */
export function rank(message, faqs) {
  // Keywords may be question words ("where", "open"), so match them against
  // every token; the FAQ wording itself only counts on meaningful words.
  const tokens = tokenize(message);
  const content = contentTokens(message);
  if (tokens.length === 0) return [];
  const denom = Math.max(2, Math.sqrt(Math.max(1, content.length)) * 1.5);
  return faqs
    .map((faq) => {
      const kw = new Set(faq.keywords.flatMap((k) => tokenize(k)));
      const qt = new Set(contentTokens(faq.q));
      let s = 0;
      for (const t of tokens) {
        if (kw.has(t)) s += 1;
        else if (qt.has(t) && !STOPWORDS.has(t)) s += 0.5;
      }
      return { faq, score: Math.min(1, s / denom) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

function hasAny(message, words) {
  const tokens = new Set(tokenize(message));
  return words.some((w) => tokens.has(tokenize(w)[0]));
}

const PHONE = /(\+?\d[\d\s-]{6,}\d)/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const BOOKING_STEPS = [
  { key: "date", ask: "Great, let's get you a table. Which day would you like?" },
  { key: "time", ask: "What time should we expect you?" },
  { key: "party", ask: "How many people?", validate: (v) => /\d+/.test(v), retry: "Please send the number of guests, e.g. 4." },
  { key: "name", ask: "And the name for the booking?" },
  {
    key: "contact",
    ask: "Last thing: a phone number or email so we can confirm.",
    validate: (v) => PHONE.test(v) || EMAIL.test(v),
    retry: "That doesn't look like a phone number or email. Could you send it again?",
  },
];

const HANDOFF_STEPS = [
  { key: "name", ask: "Sure. What's your name?" },
  {
    key: "contact",
    ask: "What phone number or email should the team use?",
    validate: (v) => PHONE.test(v) || EMAIL.test(v),
    retry: "That doesn't look like a phone number or email. Could you send it again?",
  },
];

/**
 * Create an assistant for one knowledge base.
 * onLead(lead) is called with every captured booking or hand-off request.
 */
export function createAssistant(kb, { onLead = () => {}, now = () => new Date() } = {}) {
  const sessions = new Map();

  function session(id) {
    if (!sessions.has(id)) sessions.set(id, { flow: null, step: 0, data: {}, transcript: [], lastQuestion: null });
    return sessions.get(id);
  }

  function startFlow(s, flow, extra = {}) {
    s.flow = flow;
    s.step = 0;
    s.data = { ...extra };
    const steps = flow === "booking" ? BOOKING_STEPS : HANDOFF_STEPS;
    return steps[0].ask;
  }

  function continueFlow(s, text) {
    const steps = s.flow === "booking" ? BOOKING_STEPS : HANDOFF_STEPS;
    const step = steps[s.step];
    if (step.validate && !step.validate(text)) return { text: step.retry };
    s.data[step.key] = text.trim();
    s.step += 1;
    if (s.step < steps.length) return { text: steps[s.step].ask };

    const lead = {
      type: s.flow,
      ...s.data,
      createdAt: now().toISOString(),
      transcript: s.transcript.slice(-12),
    };
    const flow = s.flow;
    s.flow = null;
    s.data = {};
    onLead(lead);
    if (flow === "booking") {
      return {
        text: `Thanks ${lead.name}! I've sent a request for ${lead.party} on ${lead.date} at ${lead.time}. The team will confirm shortly.`,
        lead,
      };
    }
    return { text: kb.business.handoffMessage, lead };
  }

  /** Handle one incoming message. Returns {text, source?, lead?, suggestions?}. */
  function reply(sessionId, message) {
    const s = session(sessionId);
    const text = String(message || "").trim();
    s.transcript.push({ from: "customer", text });
    const out = respond(s, text);
    s.transcript.push({ from: "assistant", text: out.text });
    return out;
  }

  function respond(s, text) {
    if (!text) return { text: "Sorry, I didn't catch that." };

    const lower = normalise(text);
    if (kb.guardrails.blocked.some((b) => lower.includes(b))) {
      return { text: "I can only help with questions about " + kb.business.name + ". What would you like to know?", guarded: true };
    }

    if (/^(cancel|stop|never ?mind)\b/.test(lower) && s.flow) {
      s.flow = null;
      return { text: "No problem, cancelled. Anything else I can help with?" };
    }

    if (s.flow) return continueFlow(s, text);

    if (/^(yes|yeah|yep|sure|ok|okay|po|si)\b/.test(lower) && s.lastQuestion === "handoff") {
      s.lastQuestion = null;
      return { text: startFlow(s, "handoff", { question: s.pendingQuestion }) };
    }
    s.lastQuestion = null;

    if (hasAny(text, kb.intents.booking)) return { text: startFlow(s, "booking"), intent: "booking" };
    if (hasAny(text, kb.intents.human)) return { text: startFlow(s, "handoff", { question: text }), intent: "handoff" };

    if (/^(hi|hello|hey|hej|pershendetje|ciao|buongiorno|good (morning|afternoon|evening))\b/.test(lower) && contentTokens(text).length <= 1) {
      return {
        text: `Hi! I'm the ${kb.business.name} assistant. I can answer questions, book a table or pass you to the team.`,
        suggestions: ["Opening hours", "Book a table", "Vegan options", "Talk to a person"],
      };
    }
    if (/^(thanks|thank you|thx|faleminderit|grazie)\b/.test(lower)) return { text: "You're welcome! Anything else?" };

    const [best, second] = rank(text, kb.faqs);
    if (best && best.score >= kb.guardrails.minScore) {
      const out = { text: best.faq.a, source: best.faq.id, score: Number(best.score.toFixed(2)) };
      if (second && second.score >= kb.guardrails.minScore && second.faq.id !== best.faq.id) {
        out.text += "\n\n" + second.faq.a;
        out.also = second.faq.id;
      }
      return out;
    }

    s.lastQuestion = "handoff";
    s.pendingQuestion = text;
    return { text: kb.guardrails.fallback, suggestions: ["Yes, pass it on", "No thanks"], unanswered: true };
  }

  return { reply, sessions };
}
