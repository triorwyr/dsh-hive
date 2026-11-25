/**
 * The texts of the 0.15.0 team templates that 0.16 changed, kept so that teams hired then are
 * brought along (lib/team-migration.mjs, `planLeadMigration`): a name that still reads exactly like
 * one of these takes its 0.16 name. Team id → `names` (by handle).
 *
 * The one-person company's inbox sweep, weekly numbers and market pulse moved from the dispatcher to
 * its new lead with the same texts; they move when the lead joins a team hired before
 * (`deskTasksOfLead`), not at a start.
 *
 * @module dsh-hive/lib/teams-0.15
 */

export const TEAMS_0_15 = Object.freeze({
  content: { names: { quill: { en: 'Quill', zh: 'Quill 写手' } } },
  research: { names: { memo: { en: 'Memo', zh: 'Memo 撰稿人' } } },
});
