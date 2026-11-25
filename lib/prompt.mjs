/**
 * What a bot's model reads: its persona section (router dispatcher, a
 * dispatcher working alone, or worker in a ticket session), the DM framing, the timing
 * builder its schedule tool uses, and the router's tool limits. Pure
 * functions, no Harness.
 *
 * @module dsh-hive/lib/prompt
 */

import { ABILITIES } from './abilities.mjs';

/** One roster line: `@handle — Name (dispatcher): bio`; a team's lead (Bots 0.15) is tagged `lead`. */
export function rosterLine(bot, selfId) {
  const tags = [bot.role === 'primary' ? 'dispatcher' : '', bot.lead && bot.role !== 'primary' ? 'lead' : '', bot.id === selfId ? 'you' : ''].filter(Boolean);
  return `- @${bot.handle} — ${bot.name}${tags.length ? ` (${tags.join(', ')})` : ''}${bot.bio ? `: ${bot.bio}` : ''}`;
}

/**
 * The roster as a bot reads it. Bots hired as a team (`teamNames`: team id → name) are listed under
 * their team, so that with several teams hired the dispatcher still sees who belongs together; the
 * dispatcher and bots of no team come first. Without teams it is one line per bot. A team with a
 * lead (Bots 0.15) says so on its line: `- Software squad, led by @builder:`.
 */
export function rosterLines(roster, selfId, teamNames = {}) {
  const named = (b) => b.role !== 'primary' && Boolean(teamNames[b.team]);
  const lines = roster.filter((b) => !named(b)).map((b) => rosterLine(b, selfId));
  for (const id of [...new Set(roster.filter(named).map((b) => b.team))]) {
    const lead = leadIn(roster, id);
    lines.push(`- ${teamNames[id]}${lead ? `, led by @${lead.handle}` : ''}:`);
    const members = roster.filter((x) => named(x) && x.team === id);
    // Its lead first (Bots 0.16).
    for (const b of [...members.filter((x) => x.lead), ...members.filter((x) => !x.lead)]) lines.push(`  ${rosterLine(b, selfId)}`);
  }
  return lines;
}

/** The bot that leads team `teamId` in `roster` (Bots 0.15), or null. */
export const leadIn = (roster, teamId) => (teamId ? roster.find((b) => b.team === teamId && b.lead && b.role !== 'primary') ?? null : null);

/**
 * What a team's lead reads (Bots 0.15): it gets the team's work, plans it, hands parts to its teammates
 * and answers once; and what a member of a led team reads: the work comes to it from the lead.
 */
function teamRoleLines(bot, roster, teamNames = {}) {
  if (bot.role === 'primary' || !bot.team) return [];
  const team = teamNames[bot.team] ?? bot.team;
  const lead = leadIn(roster, bot.team);
  if (!lead) return [];
  if (lead.id !== bot.id) return ['', `@${lead.handle} leads ${team}, your team: the team's work comes to you from it. What you need from a teammate you may still ask them for directly.`];
  const mates = roster.filter((b) => b.team === bot.team && b.id !== bot.id && b.role !== 'primary');
  return [
    '',
    `## You lead ${team}`,
    `${mates.length ? `Your teammates: ${mates.map((b) => `@${b.handle}`).join(', ')}. ` : ''}The dispatcher hands the team's work to you, and the person may give it to you directly. You do the main part yourself and bring the others in:`,
    '- When the work is more than one piece, plan it first; a plan bigger than a quick fix you check with the person before the work starts.',
    '- Hand the parts to your teammates with `bot_send_message` (independent ones at once): each opens a task whose report comes back to you. Then put the results together and answer once.',
    "- Work for another team goes to that team's lead, or, in a team without one, to the bot whose role fits.",
  ];
}

const LANGUAGE_LINE = '- Write to the user in the language they use (Chinese or English). Between bots, use the language of the task you were given.';
const MANAGE_LINE = '- `bot_list` shows the team with each bot\'s skills and apps; `bot_create`, `bot_update` and `bot_delete` manage bots when the user asks for it or a new specialist is clearly needed.';
const SCHEDULE_NOTICE_LINE = '- Ignore "[SCHEDULE CHANGE]" notices: they need no reply.';

/**
 * What a bot writes when a turn needs no words. Harness counts an answer with no content as a
 * failed model call (`EMPTY_RESPONSE`, retried, then the turn fails), so "end your turn without a
 * summary" must still leave text: this marker, which the plugin never shows or sends.
 */
export const NO_REPLY = 'NO_REPLY';

/** Whether a turn's text is the no-reply marker alone (any case, in backticks or with a full stop). */
export function isNoReply(text) {
  return /^[\s`*_"']*no[_ ]reply[\s`*_"'.!]*$/i.test(String(text ?? ''));
}

const NO_REPLY_LINE = `- Never end a turn with an empty answer. When nothing needs saying (a notice, an acknowledgement, or after a tool already said it all), write only ${NO_REPLY}: it is never shown or sent.`;
const SCHEDULE_LINE = 'Use `bot_schedule` to give any bot (yourself included) recurring or timed tasks: the instruction is delivered to that bot\'s conversation at each occurrence.';

/** A team's dispatcher has no Harness sub-agents (Bots 0.10): parallel help is a teammate's task, which the person can follow. The other bots keep theirs. */
const teamHelpersLine = (router) =>
  `- Your helpers are your teammates: as the dispatcher you have no Harness sub-agents (\`subagent\`, \`wait_agent\`, workflows). When a skill says to start sub-agents or parallel researchers, hand those parts to teammates with \`bot_send_message\` instead${router ? '' : ', or do them yourself one after another'}.`;

/** "Working with other bots" as a dispatcher working alone reads it (the 0.7 text, from before tasks). */
const HANDS_ON_TEAM = [
  '- Message another bot with `bot_send_message` (to: its @handle). It receives your text in its own conversation and works on it there; its answer comes back to you as a "Bot message from @…" message.',
  '- A message that starts with "Bot message from @…" was sent by that bot, not by the user. Answer it with `bot_send_message` when it asks for something; do not answer pure acknowledgements or thanks, so conversations end.',
  '- Keep messages self-contained: the other bot cannot see your conversation.',
  '- Say what a good result is: the exact deliverable (the file, the answer, the link), the constraints that matter, and how it will be judged. A vague ask comes back vague and costs a round trip.',
  '- A `done` report starts with what the person asked for and can now use, then where it is (file paths, links), then anything left undone or worth knowing. No status words at the start, no restating the request.',
  '- When you are working on a bot message, your answer goes back through `bot_send_message`; after sending it, end your turn with only ' + NO_REPLY + ' — nobody reads a summary.',
  SCHEDULE_NOTICE_LINE,
  NO_REPLY_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** "Working with other bots" as a router dispatcher reads it (`self`: its own @handle). */
const routerTeam = (self) => [
  `- Hand work to a teammate with \`bot_send_message\` (to: its @handle; never your own, @${self}: you do no work yourself, not even in a task). When no role fits exactly, pick the closest teammate: any of them can look things up, read and write. Each message opens a task (ticket) that works in a conversation of its own; the call returns at once with the ticket id and stage. To add to a task that is still open (or finished in the last day), pass \`ticket\` (its id) instead of \`to\`.`,
  '- Keep messages self-contained: the bot cannot see this conversation.',
  '- A message that starts with "Bot message from @…" was sent by that teammate, not by the person: teammates open no tasks for you, their messages come here. Tell the person in a sentence or two what they should know from it, hand out what is work, and answer the teammate only when it asks you something: with `bot_send_message` (ticket: the task its header names) when it wrote from a task, else to its @handle. Never answer acknowledgements or thanks.',
  SCHEDULE_NOTICE_LINE,
  NO_REPLY_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** "Working with other bots" as a bot's own home reads it when delegating opens tasks (router mode), the dispatcher aside. */
const HOME_TICKETS_TEAM = [
  '- Message another bot with `bot_send_message` (to: its @handle). That opens a task (ticket) for it, which it works on in a conversation of its own; the call returns at once. Never wait or poll for its answer. To add to a task you opened, pass `ticket` (its id) instead of `to`.',
  '- When the request came from the person (the panel chat, a thread in it, or a chat app), that bot answers them there itself and you get a "[Shown]" note, which needs no reply. Pass `report_to: "me"` when you need the result back yourself; it then arrives as a "Report from @… on task …" message.',
  '- A message that starts with "Report from @…" or "Bot message from @…" was sent by that bot, not by the user. Pass a report\'s result on to whoever asked; a `question` or `blocked` report needs an answer with `bot_send_message` (ticket: its id).',
  '- Keep messages self-contained: the other bot cannot see your conversation.',
  SCHEDULE_NOTICE_LINE,
  NO_REPLY_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** "Working with other bots" as a worker in a ticket session reads it. */
const TICKET_TEAM = [
  '- Ask another bot for help with `bot_send_message` (to: its @handle). That opens a sub-task for it, and its report comes back to this conversation by itself; do not wait or poll for it.',
  '- Keep messages self-contained: the other bot cannot see your conversation.',
  '- A message that starts with "Bot message from @…" or "Report from @…" was sent by that bot, not by the user.',
  SCHEDULE_NOTICE_LINE,
  NO_REPLY_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** Who asked for a ticket, as a worker reads it: `@atlas`, `task t… (@coder)`, `the user`. */
function requesterPhrase(ticket, roster) {
  const r = ticket.requester ?? {};
  const bot = r.botId ? roster.find((b) => b.id === r.botId) : undefined;
  const handle = bot ? `@${bot.handle}` : '';
  const parent = ticket.parentId ?? r.ticketId;
  if (parent) return `task ${parent}${handle ? ` (${handle})` : ''}`;
  if (ticket.board) return 'the user, from the board';
  if (r.kind === 'user' || !handle) return 'the user';
  return handle;
}

/**
 * Whether a ticket's `done`, `question` and `blocked` reports are posted as they are in the thread
 * or chat its request came from (Bots 0.9), rather than handed to whoever asked to pass on: it has
 * a Thread, it is no sub-task, and its requester did not ask for the reports (`relay`).
 */
export function reportsGoDirect(ticket) {
  const t = ticket ?? {};
  return !t.relay && Boolean(t.origin?.threadKey) && !t.parentId && !t.requester?.ticketId;
}

/** Where a ticket's direct reports are shown, as its worker reads it. */
const shownWhere = (ticket) => (String(ticket.showIn ?? ticket.origin?.threadKey ?? '').startsWith('panel:') ? 'in the panel, where the request came from' : `in the chat${ticket.origin?.via ? ` (${ticket.origin.via})` : ''} the request came from`);

/** `, for Kada on Slack` from a ticket's origin, or ''. */
function originPhrase(ticket) {
  const { who, via } = ticket.origin ?? {};
  if (!who && !via) return '';
  return `, for ${who || 'someone'}${via ? ` on ${via}` : ''}`;
}

/** The first line of a project's brief, clipped, for the list the dispatcher reads. */
const briefLine = (p) => {
  const first = String(p.brief ?? '').trim().split('\n')[0].trim();
  const chars = [...first];
  return chars.length > 160 ? `${chars.slice(0, 159).join('')}…` : first;
};

/** What a router dispatcher reads about the projects (0.12). */
function projectsSection(list) {
  return [
    '',
    '## Projects',
    'The person files their work under these projects. The panel shows each request as a card on a board, numbered within its project (OPC-12):',
    ...list.map((p) => `- ${p.key} — ${p.name}${briefLine(p) ? `: ${briefLine(p)}` : ''}`),
    '- When a new request clearly belongs to one of them, pass its key with `project` as you hand it out: its tasks then work in the project\'s folder and read its brief. Leave `project` out when none clearly fits; a request already filed keeps its project. `bot_need` (action file) files one later, when the person asks.',
    '- A message that starts with "[Card …]" is a card the person filed on the board and handed to you: its tasks count toward that card\'s need.',
    '- "Cards named: …" before a message lists the cards it names (OPC-12): each one\'s need, how far it got and its open tasks. Work for one of them passes its need, or goes to its open task (`ticket`). A message that starts with a card\'s reference goes straight to that card\'s task when it has just one; you get a "[follow_up]" note.',
    '- When the person wants a card to wait for others ("do OPC-12 after OPC-11"), set it with `bot_need` (action after): it starts by itself once they are done, with what they delivered.',
  ];
}

/** What a task of a project reads about it (0.12). */
function projectSection(p) {
  const brief = String(p.brief ?? '').trim();
  return [
    '',
    '## The project',
    `This task is part of project ${p.key} (${p.name}).${p.dir ? ` This conversation works in the project's folder, ${p.dir}.` : ''}`,
    ...(brief ? ['', brief] : []),
  ];
}

/**
 * The persona section of one bot. It replaces the deployment persona for that
 * bot's conversation only.
 * @param {object} bot
 * @param {object[]} roster - every bot, the bot itself included.
 * @param {{skillsInline?: boolean, apps?: string[], skillNames?: object, channels?: string[], dispatcher?: 'router'|'hands-on', tickets?: boolean, ticket?: object, teamNames?: object}} [extra]
 *   `channels`: chat apps the team is reachable from ('Telegram').
 *   `teamNames`: team id → name, to list hired teams' bots under their team.
 *   `dispatcher`: how the dispatcher (role 'primary') works in its home conversation: 'router' (it has teammates) only understands, hands out and reports; 'hands-on' (default: it works alone) is the 0.7 text. Ignored for other bots.
 *   `tickets`: delegating from a home opens a task whose answer arrives as a report (router mode); a non-dispatcher bot's home then says so. Without it (hands-on) the 0.7 text stands.
 *   `ticket`: the ticket (see PLAN-0.8 §10) when this conversation is that ticket's session; the text then frames the conversation as one task, whatever the bot's role.
 *   `projects`: the projects requests are filed under (0.12), which a router dispatcher reads; `project`: the ticket's own, whose brief and folder its task reads.
 */
export function personaText(bot, roster, extra = {}) {
  const ticket = extra.ticket ?? null;
  const router = !ticket && bot.role === 'primary' && extra.dispatcher === 'router';
  const homeTickets = !ticket && !router && bot.role !== 'primary' && extra.tickets === true;
  const lines = [];
  lines.push(`You are ${bot.name} (@${bot.handle}), one of the user's bots in DeepSeek Harness.`);
  if (bot.persona.trim()) lines.push('', '## Your persona', bot.persona.trim());
  const others = roster.filter((b) => b.id !== bot.id);
  lines.push('', '## The bot team');
  lines.push(roster.length > 1 ? 'These bots work for the same user and can message each other:' : 'You are the only bot so far.');
  if (roster.length > 1) lines.push(...rosterLines(roster, bot.id, extra.teamNames));
  lines.push('', '## Working with other bots', ...(ticket ? TICKET_TEAM : router ? routerTeam(bot.handle) : homeTickets ? HOME_TICKETS_TEAM : HANDS_ON_TEAM));
  if (others.length && bot.role === 'primary') lines.push(teamHelpersLine(router));
  if (ticket) {
    const direct = reportsGoDirect(ticket);
    lines.push(
      '',
      '## This conversation is one task',
      `It is task ${ticket.id}: "${String(ticket.title ?? '').trim()}", asked by ${requesterPhrase(ticket, roster)}${originPhrase(ticket)}. Its first message says what to do${ticket.origin?.said || ticket.origin?.context ? ', and under "Where it came from" what the person wrote with the chat context read with it (the message they reply to, the topic, a forwarded history): work from that, not only from the summary' : ''}.`,
      '- Report to whoever asked with `bot_send_message`: leave out `to` and give a `status`, which is required — `progress` for an update worth keeping, `done` with the result when you are finished, `blocked` when you cannot go on, `question` when you need an answer.',
      ...(direct
        ? [
            `- Your \`done\`, \`question\` and \`blocked\` reports are shown to the person as they are, ${shownWhere(ticket)}, and whoever asked is told. Write them for the person: the whole answer, in their language, nothing addressed to a bot. Their replies come back here.`,
            '- To the person a report reads as you talking to them in the chat, so write it the way you would answer there: start with the answer itself, not with its status ("done", "finished", "here is the report"), and leave out task ids and how the work was handed around.',
            '- Your plain text reaches no one: only reports do. Put everything the person needs in the report (nobody sees this conversation); after a `done` report, end your turn with only ' + NO_REPLY + '.',
          ]
        : ['- Your plain text reaches no one: only reports do. Put everything the requester needs in the report (it cannot see this conversation); after a `done` report, end your turn with only ' + NO_REPLY + '.']),
      '- Asking another bot opens a sub-task; its report comes back here by itself.',
      '- Messages from the person about this task may arrive here directly. Take them into account and answer them in a report.',
      `- \`bot_recall\` reads this task (\`ticket/${ticket.id}\`), its parent and sub-tasks, and the threads it belongs to.`,
    );
    if (extra.project) lines.push(...projectSection(extra.project));
  } else if (router) {
    lines.push(
      '',
      '## You are the dispatcher',
      'The user treats you as the main bot, and you run the team as its front desk. You do three things: understand what the person wants, hand the work out, and keep track of it. Every message gets your answer within a step or two, and the work is your teammates\': you never do it, not even a quick lookup. Searching the web, reading or changing files and running anything is a teammate\'s task. When no bot fits a recurring kind of work, propose creating one.',
      '- Every message is its own request, unless it clearly continues one of the open tasks listed with it ("[Panel]" messages list them). When several messages arrive together, handle every one of them: never drop a request because another came after it.',
      '- You put no question cards to the person: a card would hold every message after it until it is answered. When the person wants to be asked something first ("ask me which tone before you write"), hand the work out with that in the task ("before you start, ask the person which tone they want"): the teammate asks them in its task. When you yourself must know something before you can hand a request out, ask it in one short line of your reply and end your turn; their next message brings the answer.',
      '- For each request do one of these, then end your turn: answer it yourself only from what you already know (a greeting, what the person means, the team, its tasks and what they already reported); hand it out with `bot_send_message` and tell the person in a sentence what happens next, as a colleague would in a chat ("@ledger is looking into it, back in a few minutes"); or, when it continues an open task, add it to that task with `bot_send_message` (ticket: its id).',
      '- Each request of the person is a need: the panel shows them their needs and how far the work on each got. When you hand out work for a new request, pass `need` with it: the request restated for the person in one short line, in their language, saying what they get, not who does it or how ("A comparison of Q3 competitor pricing", not "@scout researches pricing"). Tasks for the same request share its need: pass the same line, or the need id the first call returned. For more work on a need listed under "Open needs", pass its id. Leave `need` out for work the person did not ask for.',
      '- When the person drops a request ("forget the logo"), drop its need with `bot_need`: its open tasks stop. When two needs turn out to be one request, merge them; when the person changes what they want, rename it.',
      '- Talk to the person like a person in a chat, in their language. Tasks, ticket ids, topics and threads are how Bots works inside: leave them out of what you say unless the person asks about them (the panel shows the tasks by itself).',
      '- A conversation that starts with "[Thread]" is a thread: the person replies to one earlier message, and you see the conversation up to it, not what came after. Stay on that message; tasks you open there answer in the thread.',
      '- A chat message may come with "[Chat context, read from …]": the message the person replies to, the earlier messages of the topic or reply chain, or chat history they forwarded. It is part of the request: "this", "the above" or "summarize" mean that context. The task you open from that message gets the person\'s words and that context by itself (forwarded history also goes with the next message, the one that asks about it), so do not copy it into the task; say what to do with it. When the work is about context from an earlier message, put what the task needs from it in the task.',
      '- Every delegation with `bot_send_message` opens a task (ticket) for that bot and returns at once. Hand independent parts to several bots in parallel: research splits by angle (money and funding to the one closest to finance, market and product to the one closest to growth, and so on), and the bot that builds something from the results gets it once they are in.',
      "- A team led by one of its bots (\"led by @…\" in the roster) takes its work through its lead: hand the team's work to the lead as the person put it, and the lead plans it, brings in its teammates and answers once. Hand a member of such a team work directly only when the person names that member. In a team without a lead, hand each member its own part.",
      '- The bot doing a task answers the person itself, where the request came from (the panel chat, a thread, or a chat app), and the person\'s replies to its answer go straight to it. You get a "[Shown]" note: it needs no reply, so do not repeat the result. Only when you must put several results together, pass `report_to: "me"`; their reports ("Report from @…") then come to you, and you answer the person.',
      '- Notes ("[Shown]", "[follow_up]", "[Threads]", "[Closed]", "[Stopped]") are for you, not the person: never answer them, and never mention them or their tags in what you say.',
      '- Reports, notes ("[Shown]", "[follow_up]") and new messages arrive by themselves. Never wait, sleep or poll for them: end your turn, and you are woken when something needs you. A `question` or `blocked` report that comes to you needs an answer: give it with `bot_send_message` (ticket: its id), or ask the person. A follow-up note needs no reply: the message already went to the task; stop the task only if the person asks.',
      '- When a turn involves more than one chat (the panel and a chat app, or two chat threads), answer each with `bot_reply` (thread: the key its header shows, or ticket: a task id) so every answer stays where it belongs; plain text then reaches none of them.',
      '- Use `bot_recall` to look up tasks and threads (`tickets`, `ticket/<id>`, `thread/<key>`, `bot/<handle>`) instead of guessing.',
      '- A task you hand out says what a good result is: the deliverable, the constraints, and how it will be judged. A vague ask comes back vague and costs the person a round trip.',
      '- Keep your own replies short: 100 words at most, no tables.',
      SCHEDULE_LINE,
    );
    if (extra.projects?.length) lines.push(...projectsSection(extra.projects));
  } else if (bot.role === 'primary') {
    lines.push(
      '',
      '## You are the dispatcher',
      'The user treats you as the main bot. For a task that fits another bot\'s role, delegate it with `bot_send_message`, possibly to several bots in parallel, then combine their answers for the user. Do small or general tasks yourself. When no bot fits a recurring kind of work, propose creating one.',
      'While teammates are still answering, stay quiet: when a reply arrives and others are still outstanding, write only ' + NO_REPLY + ' instead of writing to the user. Report once, when everything you asked for is in (or when something is blocked).',
      SCHEDULE_LINE,
    );
  }
  if (bot.role !== 'primary' && others.some((b) => b.role === 'primary')) {
    const p = others.find((b) => b.role === 'primary');
    lines.push(
      '',
      extra.dispatcher === 'router'
        ? `@${p.handle} is the dispatcher, and it does no work itself: a message to it opens no task, it goes into its own conversation, and it tells the person what they should know. When work you receive needs a skill another bot has, message that bot directly (for another team with a lead, its lead); what the person must hear or answer goes to them the usual way (${ticket ? 'a report on your task' : 'your reply'}), not through @${p.handle}.`
        : `@${p.handle} is the dispatcher. When work you receive needs a skill another bot has, you may message that bot directly.`,
    );
  }
  lines.push(...teamRoleLines(bot, roster, extra.teamNames));
  const skills = bot.skills.filter((s) => s.enabled);
  if (skills.length > 0) {
    lines.push('', '## Your skills');
    const inline = skills.filter((s) => extra.skillsInline && s.source !== 'dsh');
    const listed = skills.filter((s) => !inline.includes(s));
    if (listed.length > 0) {
      lines.push('These are the skills of your role. Load one with the `skill` tool before acting on a task it matches; prefer them over other skills in the catalog:');
      for (const s of listed) lines.push(`- ${extra.skillNames?.[s.id] ?? s.name}${s.description ? `: ${s.description.split(/(?<=[.。])\s/)[0].slice(0, 200)}` : ''}`);
    }
    for (const s of inline) lines.push('', `### ${s.name}`, s.description, '', s.content.trim());
  }
  if (extra.apps?.length) lines.push('', '## Your apps', `Tools from these connected apps are yours: ${extra.apps.join(', ')} (named \`mcp__<app>__<tool>\`).`);
  if (extra.channels?.length) {
    const first = extra.channels[0];
    const how = ticket
      ? reportsGoDirect(ticket)
        ? 'It is a follow-up about this task. Your plain text does not reach that chat: answer in a report, which is posted there.'
        : 'It is a follow-up about this task. Your plain text does not reach that chat: answer in a report, and the requester passes it on.'
      : 'Treat it like any request from the user: your reply is sent back to that chat as plain text, so keep it short, skip tables, and say plainly what you did or who is on it.';
    lines.push(
      '',
      '## Chat apps',
      `The user can also reach the team from ${extra.channels.join(' and ')}. A message that starts with "[${first} · Name]" was sent from that chat app by someone the user paired (usually the user). ${how}`,
    );
  }
  return lines.join('\n');
}

/** The first content block a DM arrives with; `ticket`: the task the sender wrote it from. */
export function dmHeader(sender, ticket = null) {
  if (!sender) return 'Bot message from the user (sent from another conversation):';
  const from = ticket ? `, from its task ${ticket.id} ("${String(ticket.title ?? '').trim()}")` : '';
  return `Bot message from @${sender.handle} (${sender.name})${from}:`;
}

/** The text of a DM as the receiving model reads it; one sent from a task (`ticket`) is answered on that task. */
export function dmBody(text, sender, ticket = null) {
  const reply = !sender ? '' : ticket ? `\n\n(If an answer is needed, give it with bot_send_message, ticket: ${ticket.id}.)` : `\n\n(Reply with bot_send_message to @${sender.handle} if an answer is needed.)`;
  return `${String(text).trim()}${reply}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** `9:5` / `09:05` / `09:05:00` → `09:05:00`; throws on anything else. */
export function clockTime(value) {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) throw new Error(`time "${value}" must be HH:MM`);
  return `${pad(m[1])}:${pad(m[2])}:${pad(m[3] ?? 0)}`;
}

/**
 * A DSH Schedule timing from the flat fields a tool call carries.
 * @param {{kind: string, at?: string, every_minutes?: number, time?: string, weekdays?: number[], cron?: string, time_zone?: string}} a
 * @param {string} zone - default IANA zone.
 */
export function timingFrom(a, zone) {
  const tz = String(a.time_zone ?? '').trim() || zone;
  switch (a.kind) {
    case 'at': {
      const at = new Date(String(a.at ?? ''));
      if (Number.isNaN(at.getTime())) throw new Error('at must be an ISO date-time, e.g. 2026-11-16T09:00:00+08:00');
      return { kind: 'at', at: at.toISOString() };
    }
    case 'every': {
      const minutes = Number(a.every_minutes);
      if (!Number.isFinite(minutes) || minutes < 1) throw new Error('every_minutes must be at least 1');
      return { kind: 'every', every_seconds: Math.round(minutes * 60) };
    }
    case 'daily':
      return { kind: 'daily', daily: { time: clockTime(a.time), time_zone: tz } };
    case 'weekly': {
      const days = [...new Set((Array.isArray(a.weekdays) ? a.weekdays : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
      if (days.length === 0) throw new Error('weekdays must list ISO weekdays, 1 = Monday … 7 = Sunday');
      return { kind: 'weekly', weekly: { time: clockTime(a.time), time_zone: tz, weekdays: days } };
    }
    case 'cron':
      if (!String(a.cron ?? '').trim()) throw new Error('cron needs a five-field expression');
      return { kind: 'cron', cron: { expression: String(a.cron).trim(), time_zone: tz } };
    default:
      throw new Error('kind must be one of at, every, daily, weekly, cron');
  }
}

/** A short English description of a timing, for tool results. */
export function describeTiming(t) {
  if (!t) return '';
  const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hm = (s) => String(s ?? '').slice(0, 5);
  switch (t.kind) {
    case 'at':
      return `once at ${t.at}`;
    case 'every':
      return t.every_seconds % 3600 === 0 ? `every ${t.every_seconds / 3600} h` : `every ${Math.round(t.every_seconds / 60)} min`;
    case 'daily':
      return `daily at ${hm(t.daily?.time)} (${t.daily?.time_zone})`;
    case 'weekly':
      return `${(t.weekly?.weekdays ?? []).map((d) => days[d]).join(', ')} at ${hm(t.weekly?.time)} (${t.weekly?.time_zone})`;
    case 'cron':
      return `cron ${t.cron?.expression} (${t.cron?.time_zone})`;
    case 'rrule':
      return t.rrule;
    default:
      return t.kind;
  }
}

/** The editable timing of a stored schedule entry, in management-input form. */
export function timingOfEntry(e) {
  const hms = (s) => String(s ?? '').slice(0, 8);
  switch (e.kind) {
    case 'after':
    case 'at':
      return { kind: 'at', at: e.scheduledAt };
    case 'every':
      return { kind: 'every', every_seconds: e.everySeconds };
    case 'daily':
      return { kind: 'daily', daily: { time: hms(e.time), time_zone: e.timeZone } };
    case 'weekly':
      return { kind: 'weekly', weekly: { time: hms(e.time), time_zone: e.timeZone, weekdays: e.weekdays } };
    case 'cron':
      return { kind: 'cron', cron: { expression: e.expression, time_zone: e.timeZone } };
    case 'rrule':
      return { kind: 'rrule', rrule: e.rrule };
    default:
      return { kind: e.kind };
  }
}

/** The text of a message's text blocks. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b, i, all) => (i < all.length - 1 && !b.text.endsWith('\n') ? `${b.text}\n` : b.text))
    .join('')
    .trim();
}

const abilityTools = (id) => ABILITIES.find((a) => a.id === id)?.tools ?? [];

/**
 * Harness tools that run commands or change files outside the abilities'
 * lists: PowerShell, the persistent terminals, and the other file editors.
 */
const OTHER_WORK_TOOLS = ['pwsh', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list', 'apply_patch', 'str_replace_editor'];

/**
 * Tools a router dispatcher is denied by default: running commands (and the
 * job tools that go with them; `pwsh` and the terminals too), writing and
 * editing files (`apply_patch` and `str_replace_editor` too), sub-agents and
 * workflows, image generation and Office tools, (0.9) the web: a search
 * takes long enough to keep the person waiting, so it is a task too; and
 * (0.10.1) question cards: `ask_user_question` holds the turn until it is
 * answered, and every message after it waits behind it. It keeps `read`,
 * `read_image`, `glob`, `grep` and `skill`.
 */
export const ROUTER_DENY = Object.freeze([
  ...new Set([...abilityTools('code'), 'write', 'edit', ...abilityTools('delegate'), ...abilityTools('images'), ...abilityTools('office'), ...abilityTools('web'), ...abilityTools('ask'), ...OTHER_WORK_TOOLS]),
]);

/** Longest `bash` / `pwsh` timeout a router may ask for, in ms. */
export const ROUTER_MAX_COMMAND_MS = 30_000;
/** The timeout Harness gives a command that names none (`dsh-bash-local`), in ms. */
export const DEFAULT_COMMAND_MS = 120_000;
/** Longest `job_output` wait a router may ask for, in ms (Harness waits 30 s when `wait` has no `timeout_ms`). */
export const ROUTER_MAX_JOB_WAIT_MS = 5_000;

const NO_WAIT = 'The dispatcher does not wait: reports and messages arrive by themselves. End your turn instead.';

/** Shell words that may stand before the command they run. */
const PREFIX_WORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup', 'nice', 'sudo', 'xargs']);

/** Does a shell command run `sleep` at a command position (`sleep 5`, `x && sleep 1`, `do sleep 2; done`, `FOO=1 sleep 3`, `$(sleep 1)`)? */
export function runsSleep(command) {
  const code = String(command ?? '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\$`]|\\.)*"/g, '""')
    .replace(/(^|\s)#[^\n]*/g, '$1');
  for (const segment of code.split(/\|\||&&|\$\(|[;&|\n(){}`]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_WORDS.has(w)) i += 1;
      else if (w === 'env' || w === 'timeout') {
        i += 1;
        while (i < words.length && (words[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (w === 'timeout' && /^\d/.test(words[i])))) i += 1;
      } else break;
    }
    const first = (words[i] ?? '').replace(/^\\/, '');
    if (first.split('/').pop() === 'sleep') return true;
  }
  return false;
}

/**
 * A guard for a router's tool calls (the shape of Harness `tools.guard`):
 * the refusal reason for a call that would make the dispatcher wait, else
 * undefined. Refused: `bash` or `pwsh` running `sleep`, or in the foreground
 * without a `timeoutMs` of at most 30 s (none given means Harness's 120 s: the
 * cap, not the shell text, is what bounds a wait such as `read -t` or
 * `tail -f`); `run_in_background` returns at once and is allowed. And
 * `job_output` waits above 5 s.
 * @param {{name: string, arguments?: object}} call
 * @returns {string|undefined}
 */
export function noWaitReason(call) {
  const name = call?.name;
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (name === 'bash' || name === 'pwsh') {
    if (runsSleep(args.command)) return `Refused: no sleep. ${NO_WAIT}`;
    if (args.run_in_background === true) return undefined;
    const given = args.timeoutMs ?? args.timeout_ms;
    const timeout = given === undefined || given === null || given === '' ? DEFAULT_COMMAND_MS : Number(given);
    if (!(timeout > 0 && timeout <= ROUTER_MAX_COMMAND_MS)) {
      return `Refused: a command here must finish within ${ROUTER_MAX_COMMAND_MS / 1000} s. Pass timeoutMs (at most ${ROUTER_MAX_COMMAND_MS}; left out it is ${DEFAULT_COMMAND_MS / 1000} s), hand long work to a bot with bot_send_message, or run it with run_in_background. ${NO_WAIT}`;
    }
  }
  if (name === 'job_output' && args.wait === true) {
    const timeout = args.timeout_ms === undefined ? Infinity : Number(args.timeout_ms);
    if (!(timeout <= ROUTER_MAX_JOB_WAIT_MS)) return `Refused: job waits above ${ROUTER_MAX_JOB_WAIT_MS / 1000} s are not allowed here (pass timeout_ms up to ${ROUTER_MAX_JOB_WAIT_MS}, or read without wait). ${NO_WAIT}`;
  }
  return undefined;
}
