import type {
  SlackParticipationDecisionCallback,
  SlackParticipationDecisionRecord,
} from "./types.js";

export async function emitParticipationDecision(
  callback: SlackParticipationDecisionCallback | undefined,
  record: SlackParticipationDecisionRecord,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(record);
  } catch {
    console.warn("eve-slack-participation onDecision callback failed");
  }
}
