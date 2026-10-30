import { defineEval } from "eve/evals";

export default defineEval({
  description: "A published saved agent runs through one real parked active-runner child.",
  async test(t) {
    const result = await t.send("Run the active saved Weather witness agent now.");
    result.expectOk();
    const opened = result.events.find(
      (event) => event.type === "child.opened" && event.data.name === "active-runner",
    );
    if (opened?.type !== "child.opened") throw new Error("ACTIVE_RUNNER_CHILD_MISSING");
    const child = t.target.attach(opened.data.sessionId);
    const bootstrap = await child.nextTurn();
    bootstrap.event("turn.started", { count: 1 });
    bootstrap.calledTool("agent_builder__bootstrap_redeem", { count: 1 });
    bootstrap.event("turn.settled", { count: 1 });

    const execution = await child.nextTurn();
    execution.event("turn.started", { count: 1 });
    execution.calledTool("fixture_read", { count: 1 });
    execution.event("turn.settled", { count: 1 });

    result.calledTool("agent_builder__prepare_active_run", { count: 1 });
    result.event("child.opened", { data: { name: "active-runner" }, count: 1 });
    result.calledTool("blocking-active-runner", { status: "completed", count: 2 });
    result.calledTool("blocking-active-runner", { status: "failed", count: 1 });
    result.eventsSatisfy("one active-runner child serves both turns", (events) =>
      events.filter((event) => event.type === "child.opened" && event.data.name === "active-runner").length === 1,
    );
    result.messageIncludes("DIRECT_EXECUTION_OK");
    result.messageIncludes("clear");
    result.messageIncludes("LEASE_CLOSED_PROVED");
    result.eventsSatisfy("third continuation fails closed with the package lease code", (events) =>
      events.some(
        (event) =>
          event.type === "call.settled" &&
          event.data.callId === "reject-third-active-turn" &&
          event.data.outcome === "failed" &&
          JSON.stringify(event.data).includes("LEASE_CLOSED"),
      ),
    );
    result.succeeded();
  },
});
