# eve-agent-builder Eve 0.63.0 fixture

This private workspace app is the PR 03 and PR 04 built-host proof. It declares PM,
implementor, QA, test-runner, and active-runner subagents explicitly; mounts
the package's pinned configuration and role helpers in each directory; and
disables every unselected Eve framework tool in each child.

`pnpm test:e2e` runs the six PR 03 deterministic `mockModel` evals plus the PR
04 `build-workflow` scenario through Eve's real nested-subagent lifecycle. It
uses root-only `defineWorkflowTool` adapters with `ctx.agent()` to await each
child turn. Eve 0.63.0 model-facing subagent tools return background receipts;
the adapters keep the deterministic state machine on the public blocking API.
The fixture isolates microsandbox state in a temporary `MSB_HOME` so it does
not open a developer's runtime database. Each invocation also clears this
fixture's `.eve/.workflow-data` to match its fresh in-memory stores, while
retaining durable state across turns within the run. It proves all five children exclude root
instructions, authored tools, connections, skills, and sandbox; observes a
structured bootstrap-ready value; continues the exact parked child; executes
an immutable active version through the original host capability adapter; and
proves both an unknown child ID and a terminal child continuation fail at the
pre-model guard. A compiled-manifest verifier independently checks every
declared child slot and disabled framework default. The build scenario resumes
on later authenticated turns, performs atomic PM and implementor handoffs,
runs QA and a side-effect-free isolated test, records the unavailable
consequential fixture as an explicit optional omission, atomically reopens the
approved draft for a user-requested PM edit, repeats implementation/test/QA in
fresh children whose model call IDs intentionally recur, refuses unverified
publication, publishes on host-verified authenticated input, and proves
current-turn get/direct-run plus next-turn roster visibility.

The workspace installs `eve@0.63.0` with the repository's tracked Eve patch,
so these built-host evals are evidence for that exact workspace runtime. The
unmodified Eve 0.63.0 baseline is tag commit
`d004e6d47e9d25d0380c24b5a47b65a18f8b2784`; the fixture does not represent
an unpatched binary run when invoked from this workspace.

Bootstrap credentials necessarily cross Eve's model-mediated tool/message
transcript. The fixture's wrapper redacts retained eval artifacts after normal
command completion, but cannot guarantee that an interrupted process or other
host instrumentation never observed the credential. Production hosts must
treat those transcripts as secret-bearing.

Eve 0.63.0 `ask_question` answers are ordinary tool results and cannot authorize
a later capability call. Consequential authorization is instead composed onto
the real lowered tool approval and backed by exact scoped, single-use store
state. The local Workflow runtime accepted but did not settle the attempted
nested approval continuation, so this fixture keeps that capability unavailable
and proves no call; reusable package conformance covers negative and exact
successful grants. These deterministic tests establish lifecycle and
containment behavior; they do not claim live-model obedience.

Multi-turn evals create an explicit `t.session()` and send follow-up turns through
that session. In Eve 0.63.0, each `t.send()` creates a new session.
