import type { Config, Session } from "../shared/types.js";
import type { PaceStore } from "./sessions.js";
import type { TurnOutcome } from "./orchestrator.js";
import {
  configuredSkills,
  enabledSkills,
  skillCommand,
  skillOption,
  skillRequest,
  type Skill,
} from "./system/skills.js";

export async function prepareTurnSkills({
  prompt, session, config, store, activateOnSave, startedAt,
}: {
  prompt: string;
  session: Session;
  config: Config;
  store: PaceStore;
  activateOnSave: boolean | (() => boolean);
  startedAt: number;
}): Promise<{ outcome: TurnOutcome } | { skills: Skill[]; request: string; routingTurns: Session["turns"] }> {
  if (
    /^(?:stop caveman|normal mode)$/i.test(prompt.trim()) &&
    session.activeSkills?.includes("caveman")
  ) {
    session.activeSkills = session.activeSkills.filter(
      (name) => name !== "caveman",
    );
    if (session.skillOptions) delete session.skillOptions.caveman;
    await store.saveChanges(session, activateOnSave);
    return {
      outcome: {
        session,
        result: "/caveman disabled for this conversation.",
        note: "Skill command",
        route: session.route,
        durationMs: Math.round(performance.now() - startedAt),
        artifacts: [],
        stages: [],
        routing: [],
      },
    };
  }
  const skills = enabledSkills(await configuredSkills(config), config);
  const invoked = skillCommand(prompt, skills);
  const request = invoked ? skillRequest(prompt, invoked) : prompt;
  const option = invoked ? skillOption(invoked, request) : undefined;
  if (invoked) {
    const active = session.activeSkills ?? [];
    session.activeSkills =
      request === "off"
        ? active.filter((name) => name !== invoked.name)
        : [...new Set([...active, invoked.name])];
    session.skillOptions ??= {};
    if (!request || request === "off")
      delete session.skillOptions[invoked.name];
    else if (option) session.skillOptions[invoked.name] = option;
    if (!request || request === "off" || option) {
      await store.saveChanges(session, activateOnSave);
      const result =
        "/" +
        invoked.name +
        (option ? " " + option : "") +
        " " +
        (request === "off" ? "disabled" : "active") +
        " for this conversation.";
      return {
        outcome: {
          session,
          result,
          note: "Skill command",
          route: session.route,
          durationMs: Math.round(performance.now() - startedAt),
          artifacts: [],
          stages: [],
          routing: [],
        },
      };
    }
  }
  const routingTurns = session.turns.map((turn) => {
    const previousSkill = skillCommand(turn.prompt, skills);
    return previousSkill
      ? { ...turn, prompt: skillRequest(turn.prompt, previousSkill) }
      : turn;
  });
  return { skills, request, routingTurns };
}
