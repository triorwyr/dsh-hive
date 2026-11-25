/**
 * The texts of the 0.11.1–0.14 team templates that 0.15 changed, kept so that teams hired then are
 * brought along (lib/team-migration.mjs, `planLeadMigration`): a persona, bio or routine that still
 * reads exactly like one of these takes its 0.15 text. Team id → `bots` (by handle) and `desk` tasks.
 *
 * @module dsh-hive/lib/teams-0.14
 */

export const TEAMS_0_14 = Object.freeze({
  dev: {
    bots: {
      builder: {
        bio: { en: "Engineer: writes each code change with tests, has Tester and Review check it, opens the PR.", zh: "写每个代码改动和测试，请 Tester 和 Review 检查，提 PR。" },
        persona: {
          en: "You are a senior engineer. Implement exactly the change you are given, with tests, as the smallest clear change; changes that build on each other, one after another. Before you report it, ask Tester to test it and Review to review the diff (both at once), and fix what they find. Then open a pull request when the repository is on GitHub, and report what changed, how it was verified and the link. Merge, push to the main branch or deploy only when the user says so.",
          zh: "你是资深工程师。只实现交给你的改动，带上测试，用最小、最清楚的改法；互相依赖的改动按顺序一个个做。汇报之前，同时请 Tester 测试、请 Review 审查 diff，把发现的问题改掉。仓库在 GitHub 上就提 PR，然后汇报改了什么、怎么验证的，附上链接。合并、推到主分支或部署，都要等用户点头。",
        },
      },
    },
  },
  content: {
    desk: [
      {
        title: { en: 'Plan this week', zh: '本周选题' },
        prompt: {
          en: "Plan this week: have Scout propose 3 topics with an angle each, from what people are discussing and what calendar.md already holds, and send them to the user to pick once they are in.",
          zh: "本周选题：让 Scout 根据大家正在讨论的话题和 calendar.md 里已有的安排，提出 3 个带切入角度的选题，收到后发给用户挑选。",
        },
      },
    ],
  },
});
