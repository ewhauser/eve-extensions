import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  compaction: { modelContextWindowTokens: 100_000 },
  model: mockModel(({ messages, toolResults, userMessageCount }) => {
    const suffix = String(userMessageCount);
    const loadId = `load-skill-${suffix}`;
    const attachmentId = `read-attachment-${suffix}`;
    const skillId = `read-skill-${suffix}`;
    const resultIds = new Set(toolResults.map((result) => result.id));

    if (!resultIds.has(loadId)) {
      return {
        toolCalls: [
          { id: loadId, input: { skill: "persistence-probe" }, name: "load_skill" },
        ],
      };
    }

    const attachmentPath = messages
      .map((message) => message.text)
      .join("\n")
      .match(/Attached file (\/workspace\/attachments\/.+?) \(text\/plain\)/)?.[1];
    if (!attachmentPath) {
      return { text: "attachment path missing from hydrated history" };
    }

    if (!resultIds.has(attachmentId) || !resultIds.has(skillId)) {
      return {
        toolCalls: [
          {
            id: attachmentId,
            input: { filePath: attachmentPath },
            name: "read_file",
          },
          {
            id: skillId,
            input: {
              filePath:
                "$HOME/.agents/skills/persistence-probe/references/persistence-sentinel.txt",
            },
            name: "read_file",
          },
        ],
      };
    }

    const attachment = toolResults.find((result) => result.id === attachmentId)?.output;
    const skill = toolResults.find((result) => result.id === skillId)?.output;
    return `attachment=${JSON.stringify(attachment)}\nskill=${JSON.stringify(skill)}`;
  }),
  modelContextWindowTokens: 100_000,
});
