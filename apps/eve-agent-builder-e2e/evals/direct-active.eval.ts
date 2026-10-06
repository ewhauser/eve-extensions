import { defineEval } from "eve/evals";

export default defineEval({
  description: "A published saved agent runs through one real parked active-runner child.",
  async test(t) {
    const session = await t.session();
    const parent = await session.start("Run the active saved Weather witness agent now.");
    const bootstrapCalled = await parent.waitForEvent("agent.started", {
      data: { name: "active-runner" },
    });
    const childId = bootstrapCalled.data.sessionId;
    const bootstrapLive = t.target.watchTurn(childId);
    const bootstrap = await bootstrapLive.result();
    bootstrap.event("turn.started", { count: 1 });
    bootstrap.calledTool("agent_builder__bootstrap_redeem", { count: 1 });
    bootstrap.event("session.waiting", { count: 1 });

    await parent.waitForEvent("task.started", {
      data: { name: "blocking-active-runner", callId: "active-execution" },
    });
    const executionLive = t.target.watchTurn(childId, {
      startIndex: bootstrap.events.length,
    });
    const execution = await executionLive.result();
    execution.event("turn.started", { count: 1 });
    execution.calledTool("fixture_read", { count: 1 });
    execution.event("turn.completed", { count: 1 });
    execution.event("session.waiting", { count: 1 });

    await parent.waitForEvent("task.started", {
      data: { name: "blocking-active-runner", callId: "reject-third-active-turn" },
    });
    const result = await parent.result();
    result.expectOk();
    t.calledTool("agent_builder__prepare_active_run", { count: 1 });
    t.event("agent.started", { data: { name: "active-runner" }, count: 1 });
    t.calledTool("blocking-active-runner", { count: 3 });
    t.eventsSatisfy("one active-runner child serves both turns", (events) =>
      events.filter((event) => event.type === "agent.started" && event.data.name === "active-runner").length === 1,
    );
    t.messageIncludes("DIRECT_EXECUTION_OK");
    t.messageIncludes("clear");
    t.messageIncludes("LEASE_CLOSED_PROVED");
    t.eventsSatisfy("third continuation fails closed with the package lease code", (events) =>
      events.some(
        (event) =>
          event.type === "task.settled" &&
          event.data.callId === "reject-third-active-turn" &&
          event.data.status === "failed" &&
          JSON.stringify(event.data).includes("LEASE_CLOSED"),
      ),
    );
    t.succeeded();
  },
});
