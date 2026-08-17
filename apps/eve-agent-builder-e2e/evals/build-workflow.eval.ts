import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Durable PM to implementor to QA workflow resumes, tests with exact-call approval, publishes atomically, and is immediately observable.",
  timeoutMs: 120_000,
  async test(t) {
    const first = await t.send("BUILD_WORKFLOW_START");
    first.expectOk();
    t.messageIncludes("BUILD_WORKFLOW_ALLOCATED_OK");
    t.calledTool("agent_builder__workflow_allocate", { count: 1 });

    const ownerSwitch = await t.send("BUILD_WORKFLOW_OWNER_SWITCH", {
      headers: { "x-fixture-principal": "fixture-other" },
    });
    ownerSwitch.expectOk();
    t.messageIncludes("BUILD_OWNER_SWITCH_ISOLATED_OK");

    const pm = await t.send("BUILD_WORKFLOW_PM");
    pm.expectOk();
    t.messageIncludes("BUILD_PM_HANDOFF_OK");
    pm.calledSubagent("pm", { count: 2 });

    const implementor = await t.send("BUILD_WORKFLOW_IMPLEMENTOR");
    implementor.expectOk();
    t.messageIncludes("BUILD_IMPLEMENTOR_HANDOFF_OK");

    const qaTest = await t.send("BUILD_WORKFLOW_QA_TEST");
    qaTest.expectOk();
    t.messageIncludes("BUILD_QA_TEST_REQUEST_OK");

    const testCompleted = await t.send("BUILD_WORKFLOW_TEST");
    testCompleted.expectOk();
    t.messageIncludes("BUILD_TEST_EVIDENCE_OK");
    testCompleted.calledSubagent("test-runner", { count: 2 });

    const qaApproved = await t.send("BUILD_WORKFLOW_QA_APPROVE");
    qaApproved.expectOk();
    t.messageIncludes("BUILD_QA_APPROVED_OK");
    const workflowAfterTest = qaApproved.events.find(
      (event) =>
        event.type === "action.result" &&
        event.data.result.callId === "build-workflow-after-test" &&
        event.data.status === "completed",
    );
    if (
      workflowAfterTest?.type !== "action.result" ||
      !JSON.stringify(workflowAfterTest.data.result.output).includes(
        '"capabilityId":"fixture.notify.consequential.v1","reason":"disabled"',
      )
    ) {
      throw new Error("OPTIONAL_TEST_OMISSION_NOT_RECORDED");
    }

    const reopened = await t.send("BUILD_WORKFLOW_REOPEN_FOR_EDIT");
    reopened.expectOk();
    t.messageIncludes("BUILD_WORKFLOW_REOPENED_OK");
    t.calledTool("agent_builder__workflow_reopen", { status: "completed", count: 1 });

    const revisedPm = await t.send("BUILD_WORKFLOW_REVISED_PM");
    revisedPm.expectOk();
    t.messageIncludes("BUILD_PM_REVISION_HANDOFF_OK");

    const revisedImplementor = await t.send("BUILD_WORKFLOW_REVISED_IMPLEMENTOR");
    revisedImplementor.expectOk();
    t.messageIncludes("BUILD_IMPLEMENTOR_REVISION_HANDOFF_OK");

    const revisedQaTest = await t.send("BUILD_WORKFLOW_REVISED_QA_TEST");
    revisedQaTest.expectOk();
    t.messageIncludes("BUILD_QA_REVISION_TEST_REQUEST_OK");

    const revisedTest = await t.send("BUILD_WORKFLOW_REVISED_TEST");
    revisedTest.expectOk();
    t.messageIncludes("BUILD_REVISION_TEST_EVIDENCE_OK");

    const revisedApproval = await t.send("BUILD_WORKFLOW_REVISED_QA_APPROVE");
    revisedApproval.expectOk();
    t.messageIncludes("BUILD_QA_REVISION_APPROVED_OK");

    const refused = await t.send("BUILD_WORKFLOW_PUBLISH_WITHOUT_APPROVAL");
    t.messageIncludes("BUILD_PUBLISH_REFUSED_OK");
    refused.calledTool("agent_builder__workflow_publish", { status: "failed", count: 1 });

    const completed = await t.send("BUILD_WORKFLOW_PUBLISH");
    completed.expectOk();
    t.messageIncludes("BUILD_WORKFLOW_PUBLISHED_CURRENT_RUN_OK");
    t.calledSubagent("pm", { count: 4 });
    t.calledSubagent("implementor", { count: 4 });
    t.calledSubagent("qa", { count: 8 });
    t.calledSubagent("test-runner", { count: 4 });
    t.calledTool("agent_builder__workflow_publish", { status: "completed", count: 1 });
    t.calledTool("agent_builder__agent_get", { count: 1 });
    t.calledTool("agent_builder__prepare_active_run", { count: 1 });
    t.calledSubagent("active-runner", { count: 2 });
    const current = completed.events.find(
      (event) =>
        event.type === "action.result" &&
        event.data.result.callId === "build-current-get" &&
        event.data.status === "completed",
    );
    if (
      current?.type !== "action.result" ||
      !JSON.stringify(current.data.result.output).includes(
        "PR04 revised deterministic workflow and publication witness",
      )
    ) {
      throw new Error("CURRENT_TURN_GET_DID_NOT_OBSERVE_REVISED_VERSION");
    }
    const nextTurn = await t.send("BUILD_WORKFLOW_NEXT_TURN");
    nextTurn.expectOk();
    t.messageIncludes("BUILD_NEXT_TURN_ROSTER_OK");
    t.messageIncludes("Published workflow witness");
    nextTurn.noFailedActions();
    t.succeeded();
  },
});
