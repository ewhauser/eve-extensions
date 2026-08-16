# eve-agent-builder Eve 0.38 fixture

This private workspace app is the PR 03 built-host proof. It declares PM,
implementor, QA, test-runner, and active-runner subagents explicitly; mounts
the package's pinned configuration and role helpers in each directory; and
disables every unselected Eve framework tool in each child.

`pnpm test:e2e` runs six deterministic `mockModel` evals through Eve's real
nested-subagent lifecycle. It proves all five children exclude root
instructions, authored tools, connections, skills, and sandbox; observes a
structured bootstrap-ready value; continues the exact parked child; executes
an immutable active version through the original host capability adapter; and
proves both an unknown child ID and a terminal child continuation fail at the
pre-model guard. A compiled-manifest verifier independently checks every
declared child slot and disabled framework default.

The workspace installs `eve@0.38.0` with the repository's tracked Eve patch,
so these built-host evals are evidence for that exact workspace runtime. PR 03
separately audits every load-bearing lifecycle and public-type claim against
the unmodified tag commit
`692c5c62b86e9a968c65c593fcf5b4f32d780788`; the fixture does not represent
an unpatched binary run when invoked from this workspace. PR 03 validation also
packs `eve-agent-builder`, copies this fixture into a clean temporary consumer,
installs registry `eve@0.38.0` without the workspace patch, and requires the
same six evals and compiled-isolation verifier to pass.

Bootstrap credentials necessarily cross Eve's model-mediated tool/message
transcript. The fixture's wrapper redacts retained eval artifacts after normal
command completion, but cannot guarantee that an interrupted process or other
host instrumentation never observed the credential. Production hosts must
treat those transcripts as secret-bearing.

The test-runner case proves only PR 03 infrastructure, not the interactive
`ask_question` policy reserved for PR 04. These deterministic tests establish
lifecycle and containment behavior; they do not claim live-model obedience.
