/**
 * Bringing teams hired from older templates to the current ones: from 0.3–0.11.0 (`planTeamMigration`),
 * where a team had a lead that only passed messages on and its own routine, which belongs to the
 * dispatcher since 0.11.1; and from 0.11.1–0.14 (`planLeadMigration`), when a team had no lead, to
 * 0.15, where a team that runs as a pipeline is led by the bot that delivers; and the names 0.16 changed
 * (`TEAMS_0_15`). A lead that joined a template as a bot of its own (0.16) is offered, not made here;
 * `deskTasksOfLead` says which of the dispatcher's routines it takes over. Only what still reads exactly as it was hired
 * changes, so a persona, bio or scheduled task someone edited is left as it is; anything already
 * brought over no longer matches, so running it again does nothing. Pure: the plan, not its doing.
 *
 * @module dsh-hive/lib/team-migration
 */

import { ADDED_LEADS, TEAMS } from './teams.mjs';
import { TEAMS_0_11 } from './teams-0.11.mjs';
import { TEAMS_0_14 } from './teams-0.14.mjs';
import { TEAMS_0_15 } from './teams-0.15.mjs';

const LANGS = ['en', 'zh'];

/** The language a text is in when it is exactly one of a bilingual pair's texts, else null. */
const langOf = (text, pair) => LANGS.find((l) => pair?.[l] && text === pair[l]) ?? null;

/** Where a 0.11.0 task of `teamId` is now, by its title in `lang`: `{desk: true, prompt}` or `{handle, prompt}`, or null. */
function taskNow(teamId, title, lang) {
  const team = TEAMS.find((t) => t.id === teamId);
  if (!team) return null;
  const desk = (team.desk ?? []).find((t) => t.title[lang] === title);
  if (desk) return { desk: true, prompt: desk.prompt[lang] };
  for (const b of team.bots) {
    const t = (b.tasks ?? []).find((x) => x.title[lang] === title);
    if (!t) continue;
    // A routine of a lead that joined the template later (0.16) was the dispatcher's until then: it goes there,
    // and moves on when the lead joins (`deskTasksOfLead`).
    if (ADDED_LEADS.includes(teamId) && b.key === team.lead) return { desk: true, prompt: t.prompt[lang] };
    return { handle: b.handle, prompt: t.prompt[lang] };
  }
  return null;
}

/**
 * The migration plan.
 * @param {{bots: object[], entries: {id: string, botId: string|null, title: string, prompt: string, timing: object}[], deskId: string|null, deskText: (lang: 'en'|'zh') => {persona: string, bio: string}}} input
 *   `entries`: the bots' scheduled tasks; `deskText`: the front desk's persona and bio in a language.
 * @returns {{bots: {id: string, patch: object}[], edits: {id: string, prompt: string}[], moves: {id: string, title: string, prompt: string, timing: object}[], drops: string[]}}
 *   `bots`: patches to save; `edits`: new prompts for tasks that stay where they are; `moves`: tasks
 *   to delete and make again on the dispatcher; `drops`: tasks to delete, the dispatcher already has one by that title.
 */
export function planTeamMigration({ bots, entries, deskId, deskText }) {
  const plan = { bots: [], edits: [], moves: [], drops: [] };
  const deskTitles = new Set(entries.filter((e) => e.botId && e.botId === deskId).map((e) => e.title));
  for (const bot of bots) {
    const was = TEAMS_0_11[bot.team]?.[bot.handle];
    if (!was) continue;
    const isDesk = bot.id === deskId;
    const now = TEAMS.find((t) => t.id === bot.team)?.bots.find((b) => b.handle === bot.handle);
    const patch = {};
    for (const k of ['persona', 'bio']) {
      const lang = langOf(bot[k], was[k]);
      if (!lang) continue;
      // A lead that is the dispatcher reads as the front desk; a member as its current template.
      const text = was.lead ? (isDesk ? deskText(lang)[k] : null) : now?.[k]?.[lang];
      if (text && text !== bot[k]) patch[k] = text;
    }
    // A lead's work skills and apps do not fit the dispatcher (an app is turned off, its keys kept).
    if (was.lead && isDesk) {
      const skills = (bot.skills ?? []).filter((s) => !(s.source === 'dsh' && was.dshSkills.includes(s.name)));
      if (skills.length !== (bot.skills ?? []).length) patch.skills = skills;
      if ((bot.apps ?? []).some((a) => a.enabled && was.apps.includes(a.template))) patch.apps = bot.apps.map((a) => (was.apps.includes(a.template) ? { ...a, enabled: false } : a));
    }
    if (Object.keys(patch).length) plan.bots.push({ id: bot.id, patch });
    for (const e of entries.filter((x) => x.botId === bot.id)) {
      const task = was.tasks.find((t) => langOf(e.title, t.title) && langOf(e.prompt, t.prompt) === langOf(e.title, t.title));
      if (!task) continue;
      const lang = langOf(e.title, task.title);
      const where = taskNow(bot.team, e.title, lang);
      if (!where) continue;
      if (!where.desk || isDesk) {
        if (where.prompt !== e.prompt) plan.edits.push({ id: e.id, prompt: where.prompt });
      } else if (!deskId) continue;
      else if (deskTitles.has(e.title)) plan.drops.push(e.id);
      else {
        plan.moves.push({ id: e.id, title: e.title, prompt: where.prompt, timing: e.timing });
        deskTitles.add(e.title);
      }
    }
  }
  return plan;
}

/**
 * The plan for teams hired from the 0.11.1–0.14 templates (Bots 0.15).
 * @param {{bots: object[], entries: {id: string, botId: string|null, title: string, prompt: string}[], deskId: string|null, giveLeads: boolean}} input
 *   `giveLeads`: leads were not given yet (the first start of 0.15). A team whose template names a lead and
 *   none of whose bots leads it then gets the bot hired as its lead (by handle); a lead taken away later stays away.
 * @returns {{bots: {id: string, patch: object}[], edits: {id: string, prompt: string}[]}}
 *   `bots`: patches to save (`lead`, and a persona or bio still as hired); `edits`: new prompts for the
 *   dispatcher's routines still as hired.
 */
export function planLeadMigration({ bots, entries, deskId, giveLeads }) {
  const patches = new Map();
  const patch = (id, fields) => patches.set(id, { ...(patches.get(id) ?? {}), ...fields });
  const edits = [];
  for (const team of TEAMS) {
    const members = bots.filter((b) => b.team === team.id && b.role !== 'primary');
    if (!members.length) continue;
    if (giveLeads && team.lead && !members.some((b) => b.lead)) {
      const handle = team.bots.find((b) => b.key === team.lead)?.handle;
      const lead = members.find((b) => b.handle === handle);
      if (lead) patch(lead.id, { lead: true });
    }
    // Names 0.16 changed (Quill 写手 → Quill 主编), still as hired.
    for (const [handle, old] of Object.entries(TEAMS_0_15[team.id]?.names ?? {})) {
      const now = team.bots.find((b) => b.handle === handle)?.name;
      for (const bot of members.filter((b) => b.handle === handle)) {
        const lang = langOf(bot.name, old);
        if (lang && now?.[lang] && now[lang] !== bot.name) patch(bot.id, { name: now[lang] });
      }
    }
    const was = TEAMS_0_14[team.id];
    if (!was) continue;
    for (const bot of members) {
      const old = was.bots?.[bot.handle];
      const now = team.bots.find((b) => b.handle === bot.handle);
      if (!old || !now) continue;
      for (const k of ['persona', 'bio']) {
        const lang = langOf(bot[k], old[k]);
        if (lang && now[k][lang] !== bot[k]) patch(bot.id, { [k]: now[k][lang] });
      }
    }
    for (const task of was.desk ?? []) {
      const now = (team.desk ?? []).find((t) => t.title.en === task.title.en);
      if (!now || !deskId) continue;
      for (const e of entries.filter((x) => x.botId === deskId)) {
        const lang = langOf(e.title, task.title);
        if (lang && e.prompt === task.prompt[lang] && now.prompt[lang] !== e.prompt) edits.push({ id: e.id, prompt: now.prompt[lang] });
      }
    }
  }
  return { bots: [...patches].map(([id, fields]) => ({ id, patch: fields })), edits };
}

/**
 * The dispatcher's routines that `teamId`'s lead runs now (0.16): its scheduled tasks whose title and
 * prompt are still, in one language, those of one of the lead's template tasks. They go when the lead
 * joins (it gets its own); one edited since stays, and the dispatcher hands its work to the lead.
 * @param {string} teamId
 * @param {{id: string, title: string, prompt: string}[]} deskEntries - the dispatcher's scheduled tasks
 * @returns {string[]} ids to delete
 */
export function deskTasksOfLead(teamId, deskEntries) {
  const team = TEAMS.find((t) => t.id === teamId);
  const lead = team?.bots.find((b) => b.key === team.lead);
  const tasks = lead?.tasks ?? [];
  return (deskEntries ?? []).filter((e) => tasks.some((t) => LANGS.some((l) => e.title === t.title[l] && e.prompt === t.prompt[l]))).map((e) => e.id);
}
