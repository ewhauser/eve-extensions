import { defineEval } from "eve/evals";

export default defineEval({
  description: "A published saved agent runs through one real parked active-runner child.",
  async test(t) {
    const parent = await t.start("Run the active saved Weather witness agent now.");
    const bootstrapCalled = await parent.waitForEvent("subagent.called", {
      data: { name: "active-runner", callId: "active-bootstrap" },
    });
    const childId = bootstrapCalled.data.childSessionId;
    const bootstrapLive = t.target.watchTurn(childId);
    const bootstrap = await bootstrapLive.result();
    bootstrap.event("turn.started", { count: 1 });
    bootstrap.calledTool("agent_builder__bootstrap_redeem", { count: 1 });
    bootstrap.event("session.waiting", { count: 1 });

    await parent.waitForEvent("subagent.called", {
      data: { name: "active-runner", callId: "active-execution", childSessionId: childId },
    });
    const executionLive = t.target.watchTurn(childId, {
      startIndex: bootstrap.events.length,
    });
    const execution = await executionLive.result();
    execution.event("turn.started", { count: 1 });
    execution.calledTool("fixture_read", { count: 1 });
    execution.event("turn.completed", { count: 1 });
    execution.event("session.waiting", { count: 1 });

    await parent.waitForEvent("subagent.called", {
      data: {
        name: "active-runner",
        callId: "reject-third-active-turn",
        childSessionId: childId,
      },
    });
    const result = await parent.result();
    result.expectOk();
    t.calledTool("agent_builder__prepare_active_run", { count: 1 });
    t.calledSubagent("active-runner", { count: 2 });
    t.eventsSatisfy("all active-runner calls address one declared child", (events) => {
      const childIds = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "active-runner"
          ? [event.data.childSessionId]
          : [],
      );
      return childIds.length === 3 && childIds[0] !== undefined && childIds.every((id) => id === childIds[0]);
    });
    t.messageIncludes("DIRECT_EXECUTION_OK");
    t.messageIncludes("clear");
    t.messageIncludes("LEASE_CLOSED_PROVED");
    t.eventsSatisfy("third continuation fails closed with the package lease code", (events) =>
      events.some(
        (event) =>
          event.type === "action.result" &&
          event.data.result.callId === "reject-third-active-turn" &&
          JSON.stringify(event.data.result).includes("LEASE_CLOSED"),
      ),
    );
    t.succeeded();
  },
});
