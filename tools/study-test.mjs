/*
  The study route, without spending anything.

  What is worth pinning here is not the model's judgement -- that is the
  model's -- but everything around it: that a search-backed answer is actually
  allowed to search, that a paused turn is picked back up rather than returned
  as an answer, that a half-filled tool call is refused rather than shown, and
  that nothing is sent anywhere until there is something to send.

  The client is replaced with one that answers from a script, so this runs
  offline and costs nothing.

  Run: node tools/study-test.mjs
*/

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failures.push(detail ? `${label} -- ${detail}` : label);
  console.log(`  ${ok ? "ok " : "NO "} ${label}`);
};

process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(80)}`;

const module = await import("../api/study.js");
const study = module.default;
const run = module.run;

/* Every request the fake client was given, and the answers it was told to give. */
let sent = [];
let script = [];

const scripted = {
  messages: {
    create: async (params) => {
      sent.push(params);
      const next = script.shift();
      if (!next) throw new Error("the script ran out");
      return { usage: { input_tokens: 10, output_tokens: 20 }, ...next };
    },
  },
};

const toolUse = (name, input) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "t1", name, input }],
});

/** Drives the handler the way the platform would, and returns what it wrote. */
async function call(action, body) {
  sent = [];
  const req = { method: "POST", url: `/api/study?action=${action}`, headers: {}, body };
  let code = 0;
  let written = null;
  // json() sets statusCode and calls end(); it does not use writeHead.
  const res = {
    set statusCode(status) { code = status; },
    get statusCode() { return code; },
    setHeader() {},
    writeHead(status) { code = status; return this; },
    end(text) { try { written = JSON.parse(text); } catch (err) { written = text; } },
  };
  await study(req, res);
  return { code, body: written };
}

/** The conversation itself, against a client that answers from the script. */
async function ask(action, body) {
  sent = [];
  try {
    return { body: await run(action, body, scripted) };
  } catch (err) {
    return { error: err, code: err.status || 0, body: { message: err.message } };
  }
}

console.log("\nnothing is sent until there is something to send");

{
  script = [];
  const empty = await call("estimate", { title: "  " });
  check("a step with no name is not sent anywhere", sent.length === 0);
  check("and is answered rather than errored over", empty.body.thin === true, JSON.stringify(empty.body));
  check("with words that say what to do", /title first/.test(empty.body.message), empty.body.message);

  const nothing = await call("schedule", { work: [] });
  check("an empty schedule asks nothing of the model", sent.length === 0);
  check("and says what is missing", /coursework/.test(nothing.body.message), nothing.body.message);

  const unknown = await call("nonsense", { title: "x" });
  check("an action that does not exist is refused", unknown.code === 400);
}

console.log("\nestimating");

{
  script = [toolUse("estimate", {
    hours: 18, low: 14, high: 25, confidence: "high", shape: "long",
    sessionMinutes: 120, why: "Mostly redrafting.",
  })];
  const answer = await ask("estimate", { title: "Extended essay, first draft", subject: "history" });

  check("the answer comes back", Boolean(answer.body.result), JSON.stringify(answer.body));
  check("with the hours in it", answer.body.result.hours === 18);
  check("the model is allowed to search the web",
    sent[0].tools.some((tool) => tool.type === "web_search_20260209"), JSON.stringify(sent[0].tools.map((t) => t.type || t.name)));
  check("but not an unlimited number of times", sent[0].tools[0].max_uses === 5);
  check("and the title is what it is asked about",
    /Extended essay, first draft/.test(sent[0].messages[0].content));
  check("nothing is forced: the current Opus refuses a forced tool choice",
    sent[0].tool_choice === undefined);

  // Half an answer reads as a finished one, which is worse than none at all.
  script = [toolUse("estimate", { hours: 18, confidence: "high" })];
  const partial = await ask("estimate", { title: "Extended essay" });
  check("an answer missing half its fields is refused", partial.code === 502, String(partial.code));
  check("and says to try again", /Try again/.test(partial.body.message), partial.body.message);
}

console.log("\na turn that pauses to search");

{
  /*
    A long search comes back paused rather than finished. Treating that as an
    answer is how a search-backed estimate silently becomes a guess, so the
    conversation is handed back and asked again.
  */
  script = [
    { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] },
    toolUse("estimate", {
      hours: 6, low: 4, high: 9, confidence: "medium", shape: "short",
      sessionMinutes: 45, why: "Vocabulary, in pieces.",
    }),
  ];
  const answer = await ask("estimate", { title: "Polish vocabulary, chapter 4" });

  check("a paused turn is picked back up", sent.length === 2, String(sent.length));
  check("and the second turn carries the first", sent[1].messages.length > 1);
  check("so the answer is the finished one", answer.body.result.hours === 6);
  check("with both turns counted", answer.body.cost.in === 20);
}

console.log("\nscheduling");

{
  script = [toolUse("schedule", {
    sessions: [{ courseworkId: "ia", date: "2026-10-20", time: "19:00", minutes: 90, why: "Long enough to draft" }],
    note: "Three evenings a week, none of them the night before the test.",
    warnings: [],
  })];
  const answer = await ask("schedule", {
    today: "2026-10-06",
    work: [{ id: "ia", title: "Economics IA", hoursOwed: 9, steps: [] }],
    busy: [], done: [], kept: [],
  });

  check("the plan comes back", answer.body.result.sessions.length === 1);
  check("the planner does not get to search", sent[0].tools.every((tool) => !tool.type));
  check("it is told what was actually done", /\"done\"/.test(sent[0].messages[0].content));
  check("and given room to think", sent[0].max_tokens >= 12000);
}

console.log("\ndefending the plan");

{
  script = [toolUse("argue", {
    verdict: "This plan spends the next two weeks on the essay and lets the vocabulary ride.",
    points: [
      { claim: "The essay gets Sunday morning", because: "It is the only three-hour block before the 24th, and your notes say the methodology has to be redone." },
      { claim: "Nothing on Thursday", because: "The maths test is Friday and the evening before it belongs to the test." },
    ],
    weakest: "Two hours for the vocabulary is thin if the list is longer than you said.",
    risk: "Two more missed evenings and the essay cannot be finished in the hours you have given it.",
    change: "I would move the Sunday sitting earlier if the supervisor answers before Friday.",
  })];
  const answer = await ask("explain", {
    today: "2026-10-07",
    work: [{ id: "ee", title: "Extended essay", notes: "Supervisor wants the methodology redone.", hoursOwed: 14, steps: [] }],
    sessions: [{ date: "2026-10-11", time: "10:00", minutes: 180, courseworkId: "ee", why: "Long block" }],
    busy: [], done: [],
  });

  check("the plan comes back argued", answer.body.result.points.length === 2);
  check("the model is told to argue rather than summarise",
    /Argue, do not summarise/.test(sent[0].system), "the system prompt lost its instruction");
  check("and to name the part it would defend least",
    Boolean(answer.body.result.weakest), JSON.stringify(answer.body.result));
  check("the sittings it is defending are sent with it",
    /2026-10-11/.test(sent[0].messages[0].content));
  check("an organiser with nothing in it is not argued about",
    (await call("explain", { work: [] })).body.thin === true);
}

console.log("\nthe notes, which are the best information there is");

{
  script = [toolUse("estimate", {
    hours: 20, low: 16, high: 28, confidence: "high", shape: "long",
    sessionMinutes: 150, why: "The methodology rewrite is most of it.",
  })];
  await ask("estimate", {
    title: "Second draft",
    piece: "Extended essay",
    notes: "4000 words on Polish inflation 1989-1995. Supervisor wants the methodology redone.",
    subject: "economics", kind: "ee", due: "2026-11-02",
  });
  const asked = sent[0].messages[0].content;
  check("the notes are sent with the step", /methodology redone/.test(asked), asked.slice(0, 200));
  check("so is the piece the step belongs to", /Extended essay/.test(asked));
  check("and the model is told what they are worth",
    /The notes are the best information you have/.test(sent[0].system));

  script = [toolUse("schedule", { sessions: [], note: "Nothing fits." })];
  await ask("schedule", {
    today: "2026-10-07",
    work: [{ id: "ee", title: "Extended essay", notes: "Four of the six sources are read.", hoursOwed: 9, steps: [] }],
    busy: [], done: [], kept: [],
  });
  check("the planner is given them too",
    /four of the six sources are read/i.test(sent[0].messages[0].content));
}

console.log("\nreading the day back");

{
  script = [toolUse("read_back", { line: "Forty-five minutes of ninety.", owed: 0.75, replan: false })];
  const answer = await ask("checkin", {
    today: "2026-10-06",
    planned: [{ what: "Economics IA", minutes: 90 }],
    reported: [{ sessionId: "a", minutes: 45, planned: 90, done: false }],
    recent: [],
  });
  check("the day comes back in one line", answer.body.result.line === "Forty-five minutes of ninety.");
  check("with the hours it still owes", answer.body.result.owed === 0.75);
  check("and whether that means replanning", answer.body.result.replan === false);
}

console.log("\nwhen the model will not answer in the shape");

{
  script = [{ stop_reason: "end_turn", content: [{ type: "text", text: "I would rather talk about it." }] }];
  const prose = await ask("checkin", { today: "2026-10-06", planned: [], reported: [], recent: [] });
  check("prose is handed back rather than erroring over", Boolean(prose.body));
  check("with the result empty so nothing mistakes it for an answer", prose.body.result === null);
  check("and what it actually said kept", /rather talk/.test(prose.body.prose), prose.body.prose);

  /* Round and round is not an answer either. */
  script = Array.from({ length: 8 }, () => ({
    stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }],
  }));
  const circles = await ask("estimate", { title: "Something it cannot settle" });
  check("a turn that never lands is given up on", circles.code === 502);
  check("and says so plainly", /circles/.test(circles.body.message), circles.body.message);
}

console.log("\nchanging a plan that already exists");

{
  const work = [{ id: "c1", title: "Economics IA", due: "2026-11-01", steps: [] }];
  const current = [
    { date: "2026-10-12", time: "19:00", minutes: 90, courseworkId: "c1", why: "first pass" },
  ];

  // Refusing happens in the handler, before the model is reached, so these
  // two go through call() rather than run().
  const nothing = await call("revise", { today: "2026-10-08", work: [], sessions: current, instruction: "less history" });
  check("with no coursework there is nothing to change", nothing.body.thin === true, JSON.stringify(nothing.body));
  check("and nothing is sent", sent.length === 0, String(sent.length));

  const unplanned = await call("revise", { today: "2026-10-08", work, sessions: [], instruction: "less history" });
  check("and with no plan it says to plan first",
    /Plan the study sessions first/.test(unplanned.body.message), unplanned.body.message);

  script = [toolUse("revise", {
    sessions: [{ courseworkId: "c1", date: "2026-10-13", time: "19:00", minutes: 90, why: "moved off Sunday" }],
    changes: ["Economics IA moved from Sunday 12th to Monday 13th."],
    note: "Your weekend is clear.",
    refused: "",
  })];
  const done = await ask("revise", {
    today: "2026-10-08", work, sessions: current, instruction: "I am away this weekend",
    kept: [{ date: "2026-10-15", time: "18:00", minutes: 60 }],
  });

  check("the whole schedule comes back", Array.isArray(done.body.result.sessions));
  check("with an account of what moved", done.body.result.changes.length === 1, JSON.stringify(done.body.result.changes));

  const asked = sent[0].messages[0].content;
  check("what the reader said is put to the model", /away this weekend/.test(asked), asked.slice(0, 200));
  check("along with the plan it is changing", /"current"/.test(asked), asked.slice(0, 300));
  check("and the sittings made by hand, to work around", /"kept"/.test(asked), asked.slice(0, 300));
  check("the planner's own rules still apply to a change",
    /Never more than three hours of study on a school night/.test(sent[0].system), true);
  check("and the rule that makes a change a change",
    /Change as little as possible/.test(sent[0].system), true);

  /* With no instruction, the model is being asked to fix what it found. */
  script = [toolUse("revise", { sessions: [], changes: [], note: "Nothing needed moving." })];
  const own = await ask("revise", { today: "2026-10-08", work, sessions: current, instruction: "" });
  check("it can also be asked to fix what it found itself",
    /You found the fault yourself/.test(sent[0].messages[0].content), true);
  check("and a change that changes nothing is allowed", own.body.result.changes.length === 0);
}

console.log("\nwithout a key");

{
  const was = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const none = await call("estimate", { title: "Extended essay" });
  check("nothing is attempted", none.code === 503, String(none.code));
  check("and the reason is the key", /ANTHROPIC_API_KEY/.test(none.body.problem), none.body.problem);
  process.env.ANTHROPIC_API_KEY = was;
}

console.log(`\nstudy-test: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
