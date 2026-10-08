import { cors, json } from "./_store.js";
import { aiClient, aiReport, MODEL } from "./_ai.js";
import { CHECKIN_SYSTEM, ESTIMATE_SYSTEM, EXPLAIN_SYSTEM, REVISE_SYSTEM, SCHEDULE_SYSTEM } from "./_playbook.js";

/**
 * The study route. Three questions, all of them the model's to answer.
 *
 *   POST /api/study?action=estimate   how long will this piece take?
 *   POST /api/study?action=schedule   when should I sit down, and for how long?
 *   POST /api/study?action=checkin    I did this much today. Where does that leave me?
 *   POST /api/study?action=explain    defend this plan to me
 *   POST /api/study?action=revise     change this plan, here is what is wrong
 *
 * The planner used to be arithmetic here: spacing by an effort slider, days
 * chosen by a load score. It placed sittings, but it could not know that a
 * mathematics exploration wants three long evenings and vocabulary wants nine
 * short ones, because the only thing it had ever read about the work was a
 * number from one to five. The model has the titles.
 */
export const maxDuration = 60;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "method-not-allowed" });

  const report = aiReport();
  if (!report.configured) return json(res, 503, { ok: false, configured: false, ...report });

  const action = new URL(req.url, "http://localhost").searchParams.get("action") || "";
  const ask = ACTIONS[action];
  if (!ask) return json(res, 400, { error: "unknown-action", message: `There is no "${action}".` });

  const body = await readBody(req);
  if (!body || typeof body !== "object") {
    return json(res, 400, { error: "no-body", message: "Nothing was sent." });
  }

  const refusal = ask.refuse(body);
  if (refusal) return json(res, 200, { ok: true, thin: true, message: refusal });

  try {
    const answer = await run(action, body);
    return json(res, 200, { ok: true, action, model: MODEL, ...answer });
  } catch (err) {
    console.error(`study ${action} failed:`, err.status || "", err.message);
    return json(res, 502, { ok: false, action, ...describe(err) });
  }
}

/* ---------- The shapes an answer may take ---------- */

const ESTIMATE_SHAPE = {
  type: "object",
  properties: {
    hours: { type: "number", description: "Your single best estimate of the hours of actual work, to the nearest half hour." },
    low: { type: "number", description: "Hours if it goes well." },
    high: { type: "number", description: "Hours if it does not." },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "high when you know the component and its requirements; low when the title could mean several things.",
    },
    shape: {
      type: "string",
      enum: ["long", "short", "mixed"],
      description: "long for work with a warm-up cost (writing, coding, a long calculation); short for work that can be stopped mid-way (memorising, past papers, reading); mixed when it genuinely has both phases.",
    },
    sessionMinutes: { type: "number", description: "How long one sitting on this should be, in minutes. Between 30 and 180." },
    sittings: { type: "number", description: "Roughly how many sittings that makes." },
    why: { type: "string", description: "Two or three sentences: what you took the task to be, what drives the hours, and what would move the number. Second person." },
    assumed: { type: "string", description: "What you had to assume because the title did not say. One sentence, or empty if nothing." },
    sources: {
      type: "array",
      maxItems: 3,
      items: { type: "string", description: "A page you actually read, as a short title. Only if you searched." },
    },
  },
  required: ["hours", "low", "high", "confidence", "shape", "sessionMinutes", "why"],
};

const SCHEDULE_SHAPE = {
  type: "object",
  properties: {
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          courseworkId: { type: "string", description: "Exactly the id given in the work. Empty when this sitting is for a calendar deadline instead. Never an id that is not there." },
          taskId: { type: "string", description: "Exactly the id given in the deadlines. Empty when this sitting is for a piece of coursework instead. Set exactly one of this and courseworkId." },
          stepId: { type: "string", description: "The step this sitting is for, or empty for the piece as a whole." },
          date: { type: "string", description: "YYYY-MM-DD. Never today or earlier." },
          time: { type: "string", description: "HH:MM, 24 hour. 19:00 unless there is a reason." },
          minutes: { type: "number", description: "30 to 180." },
          why: { type: "string", description: "Under twelve words: why this work on this evening." },
        },
        required: ["date", "time", "minutes", "why"],
      },
    },
    note: { type: "string", description: "One or two sentences to the student about the shape of the plan, and anything that does not fit in the hours they have given. Second person." },
    warnings: {
      type: "array",
      maxItems: 3,
      items: { type: "string", description: "Something the plan cannot solve, under fifteen words." },
    },
  },
  required: ["sessions", "note"],
};

/*
  The schedule again, plus an account of itself. The sessions are the same
  shape as a fresh plan because they replace it wholesale; `changes` is the
  part that makes a rewrite reviewable rather than something that happened to
  your week while you were reading a different sentence.
*/
const REVISE_SHAPE = {
  type: "object",
  properties: {
    sessions: SCHEDULE_SHAPE.properties.sessions,
    changes: {
      type: "array",
      maxItems: 12,
      items: { type: "string", description: "One change, past tense, naming the piece and the date. Under twenty words." },
      description: "Every sitting you moved, added, lengthened, shortened or dropped. Empty only if you changed nothing.",
    },
    note: { type: "string", description: "One or two sentences: what you did and anything you were asked for and could not do. Second person." },
    refused: { type: "string", description: "Empty unless you declined part of the instruction. If so, the part you declined and why, in one sentence." },
    warnings: {
      type: "array",
      maxItems: 3,
      items: { type: "string", description: "Something the plan still cannot solve, under fifteen words." },
    },
  },
  required: ["sessions", "changes", "note"],
};

const CHECKIN_SHAPE = {
  type: "object",
  properties: {
    line: { type: "string", description: "One sentence, second person, with the number in it." },
    owed: { type: "number", description: "Hours that were planned for today and not done, which the schedule still owes." },
    replan: { type: "boolean", description: "True when the schedule should be laid out again: a pattern has changed, or enough has been missed that the remaining evenings cannot carry it." },
  },
  required: ["line", "owed", "replan"],
};

const EXPLAIN_SHAPE = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "One sentence: what this plan is actually doing. Not a summary of the dates, the shape of the bet it is making." },
    points: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The decision being defended, under ten words. For example: 'The essay gets Sunday morning'." },
          because: { type: "string", description: "Why, in one or two sentences, with the hours and dates in it. Name the piece and the note it came from where there is one." },
        },
        required: ["claim", "because"],
      },
      description: "Three to five arguments, strongest first. Each is a real choice the plan made, not a description of it.",
    },
    weakest: { type: "string", description: "The part of this plan you would defend least, named plainly, and what it would take to fix it. Every plan has one." },
    risk: { type: "string", description: "The thing most likely to make this plan fail, in one sentence. Usually a deadline, a run of missed evenings, or an estimate you do not believe." },
    change: { type: "string", description: "The one thing you would change first, and what would have to be true for you to change it." },
  },
  required: ["verdict", "points", "weakest", "risk"],
};

const ACTIONS = {
  estimate: {
    system: ESTIMATE_SYSTEM,
    shape: ESTIMATE_SHAPE,
    tool: "estimate",
    about: "Report how long the work will take. Always answer by calling this.",
    /* Searching is the point of this one: the IB revises its guides. */
    search: 5,
    tokens: 6000,
    refuse: (body) => (typeof body.title === "string" && body.title.trim().length >= 3
      ? "" : "There is nothing to estimate yet: give the piece a title first."),
    prompt: (body) => `Estimate this piece of work.\n\n${JSON.stringify({
      step: String(body.title).slice(0, 200),
      /* The piece the step belongs to, and the student's own notes on it:
         a draft of what, exactly, is most of the question. */
      piece: String(body.piece || "").slice(0, 200),
      subject: String(body.subject || "").slice(0, 80),
      kind: String(body.kind || "").slice(0, 80),
      due: String(body.due || "").slice(0, 10),
      notes: String(body.notes || "").slice(0, 600),
      steps: Array.isArray(body.steps) ? body.steps.slice(0, 20).map((s) => String(s).slice(0, 120)) : [],
    }, null, 1)}`,
  },

  schedule: {
    system: SCHEDULE_SYSTEM,
    shape: SCHEDULE_SHAPE,
    tool: "schedule",
    about: "Lay out the sittings. Always answer by calling this.",
    search: 0,
    tokens: 12000,
    refuse: (body) => (
      (Array.isArray(body.work) && body.work.length > 0)
      || (Array.isArray(body.deadlines) && body.deadlines.length > 0)
        ? "" : "There is nothing to plan: add a deadline to the calendar, or a piece of coursework."),
    prompt: (body) => `Lay out my study sessions.\n\n${JSON.stringify({
      today: String(body.today || "").slice(0, 10),
      horizonDays: Number(body.horizonDays) || 28,
      work: body.work,
      deadlines: body.deadlines,
      busy: body.busy,
      done: body.done,
      kept: body.kept,
    }, null, 1)}`,
  },

  explain: {
    system: EXPLAIN_SYSTEM,
    shape: EXPLAIN_SHAPE,
    tool: "argue",
    about: "Make the case for the plan as it stands. Always answer by calling this.",
    search: 0,
    tokens: 8000,
    refuse: (body) => (
      (Array.isArray(body.work) && body.work.length > 0)
      || (Array.isArray(body.deadlines) && body.deadlines.length > 0)
        ? "" : "There is nothing to argue about yet: add a deadline, or a piece of coursework."),
    prompt: (body) => `Defend this plan to me.\n\n${JSON.stringify({
      today: String(body.today || "").slice(0, 10),
      work: body.work,
      deadlines: body.deadlines,
      sessions: body.sessions,
      busy: body.busy,
      done: body.done,
    }, null, 1)}`,
  },

  revise: {
    system: REVISE_SYSTEM,
    shape: REVISE_SHAPE,
    tool: "revise",
    about: "Return the whole schedule again, with the change made. Always answer by calling this.",
    search: 0,
    tokens: 12000,
    refuse: (body) => {
      const anything = (Array.isArray(body.work) && body.work.length > 0)
        || (Array.isArray(body.deadlines) && body.deadlines.length > 0);
      if (!anything) {
        return "There is nothing to change: add a deadline to the calendar, or a piece of coursework.";
      }
      if (!Array.isArray(body.sessions) || body.sessions.length === 0) {
        return "There is no plan to change yet. Plan the study sessions first.";
      }
      return "";
    },
    prompt: (body) => `${String(body.instruction || "").trim()
      ? `Change my plan. Here is what I want different:\n\n${String(body.instruction).slice(0, 1200)}`
      : "Change my plan. You found the fault yourself; fix it."}\n\n${JSON.stringify({
      today: String(body.today || "").slice(0, 10),
      horizonDays: Number(body.horizonDays) || 28,
      work: body.work,
      deadlines: body.deadlines,
      current: body.sessions,
      busy: body.busy,
      kept: body.kept,
      done: body.done,
    }, null, 1)}`,
  },

  checkin: {
    system: CHECKIN_SYSTEM,
    shape: CHECKIN_SHAPE,
    tool: "read_back",
    about: "Read the day back. Always answer by calling this.",
    search: 0,
    tokens: 2000,
    refuse: () => "",
    prompt: (body) => `Here is my day.\n\n${JSON.stringify({
      today: String(body.today || "").slice(0, 10),
      planned: body.planned,
      reported: body.reported,
      recent: body.recent,
    }, null, 1)}`,
  },
};

/*
  One question, asked until it is answered.

  A turn that uses the web can come back paused rather than finished -- the
  search is still running on Anthropic's side -- and the only correct response
  is to hand the same conversation back and ask again. Treating a pause as an
  answer is how a search-backed estimate silently becomes a guess.
*/
const MAX_TURNS = 6;

/*
  The client is a parameter with a default rather than a lookup, so the shape
  of a conversation -- a paused search picked back up, a half-filled tool call
  refused -- can be tested against a scripted one without a key, a network, or
  a bill.
*/
export async function run(action, body, client = aiClient()) {
  const ask = ACTIONS[action];

  const tools = [{
    name: ask.tool,
    description: ask.about,
    input_schema: ask.shape,
  }];
  if (ask.search > 0) {
    tools.unshift({ type: "web_search_20260209", name: "web_search", max_uses: ask.search });
  }

  const messages = [{ role: "user", content: ask.prompt(body) }];
  const cost = { in: 0, out: 0, searches: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: ask.tokens,
      system: ask.system,
      messages,
      tools,
      // No tool_choice: the current Opus accepts neither "tool" nor "any", so
      // the tool is offered and the prompt asks for it.
    });

    const usage = message.usage || {};
    cost.in += usage.input_tokens || 0;
    cost.out += usage.output_tokens || 0;
    cost.searches += message.content.filter((block) => block.type === "web_search_tool_result").length;

    const reported = message.content.find(
      (block) => block.type === "tool_use" && block.name === ask.tool
    );
    if (reported) {
      const missing = (ask.shape.required || []).filter((field) => reported.input[field] === undefined);
      if (missing.length > 0) {
        // Half an answer reads as a finished one, which is worse than none.
        const err = new Error(message.stop_reason === "max_tokens"
          ? "That ran long and was cut off before it finished. Try again."
          : "That came back incomplete. Try again.");
        err.status = 502;
        throw err;
      }
      return { result: reported.input, cost };
    }

    if (message.stop_reason === "pause_turn" || message.content.some((b) => b.type === "server_tool_use")) {
      messages.push({ role: "assistant", content: message.content });
      // Nothing to add: the next turn continues the same work.
      if (message.stop_reason !== "pause_turn") {
        messages.push({ role: "user", content: `Now call ${ask.tool} with your answer.` });
      }
      continue;
    }

    const prose = message.content.filter((block) => block.type === "text")
      .map((block) => block.text).join("").trim();
    return { result: null, prose, cost };
  }

  const err = new Error("That went round in circles without answering. Try again.");
  err.status = 502;
  throw err;
}

function describe(err) {
  const status = err && err.status ? err.status : 0;
  return {
    status,
    message:
      status === 401 ? "The key was refused. Check it was copied whole."
      : status === 402 ? "The key works, but the account has no credit left."
      : status === 429 ? "Rate limited. Try again in a moment."
      : status === 529 ? "Claude is busy. Try again in a moment."
      : (err && err.message) || "The request failed.",
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    return null;
  }
}
