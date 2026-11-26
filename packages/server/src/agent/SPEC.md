---
id: submodule-server-agent
type: submodule-design
status: active
title: agent — SDK execution and application sessions
parent: module-server
depends-on: [module-contracts]
tags: [agents-sdk]
---

## Responsibility

Own DesignRail sessions, application transcript projection and one active OpenAI Agents SDK Runner per session. The SDK owns the model loop and tool dispatch. The host owns identity, workspace grants, durable records, interaction ownership and completion. There is one execution path for every launcher.

Root runs use the SDK's public `maxTurns: 50` bound so complete ordinary workflows can exceed the
initial twenty-round implementation limit. Child runs retain their definition's explicit bound or
default to twenty; foreground child and compaction bounds remain unchanged. Exhaustion stays a
native length failure, never an automatic outer continuation or successful completion.

## Boundary

The public `index.ts` exposes session create/read/prompt/abort/delete, session publishers, model configuration, one-shot SDK calls and the retained MCP/Skills configuration services. Sibling modules use this barrel only. SDK objects, credentials and checkpoints never enter browser contracts. Sessions use fresh application JSON records under `<dataDir>/sessions`; old pi records, settings, providers and extensions are not read or imported.

Each `session.event` envelope carries session ID, run ID and monotonically increasing sequence. Transcript messages have stable IDs. Final output corrects the corresponding streamed message. Snapshot reads return their event watermark. Execution indicators begin only when an executor starts, after approval. Settlement waits for model/tool cleanup; a cancelled or pending-approval stream is never successful.

Tool failure status comes from invalid call JSON, SDK error callbacks, command exit results and explicit approval rejection, never from text returned by repository files or tools. The run's per-call metadata carries this status into both live and saved tool results.

Each run creates a new AbortController and workspace-bound tools. Stop revokes the grant before aborting the model and subprocess group. Tools revalidate grant and an existing workspace record before effects. Read/search/edit paths use the filesystem resolver, including real paths, symlinks, new-file ancestors and `.git` checks. Ordinary chats use `runBounded` in the assigned worktree with time/output bounds. The host subprocess tools capture configured model-key environment references at run creation and exclude those names, plus common secret names, from child environments. Edits check original text, apply the SDK diff and replace atomically.

Sandbox chats without a Handoff graph can opt in to retained memory. The native SDK injects the
shared session summary into agent instructions. Handoff chats keep their per-agent history and
tool policies and leave retained memory disabled. The same Runner handles both native memory stages
after a successful chat response. Extraction uses structured output. Consolidation uses the
existing workspace tools and bounded private memory file tools. The raw memory file and selected
rollout paths identify the private inputs. A successful private read returns the entire file within
its size limit. Project shell commands operate on the worktree. Approval and effect receipts use
the owning chat. Stop aborts generation. An interrupted generation leaves the last committed
archive available. The host clears a pending generation decision after process loss because the
SDK keeps its generation job inside the issuing Runner.

The archive holds SDK workspace files under the session and worktree identity. Recovery checks the
current grant before opening it in a fresh runtime. Git remains the authority for project files.
After the summary is saved, the SDK writes `memories/phase_two_selection.json` for the current update.
Only a successful selection write makes that update eligible for archiving. A rejected write preserves
the previous archive even when the chat succeeds. The session record commits the archive against its
current revision. Deleting the chat moves its session record and archive from active storage to the
application Trash.

The per-session Sandbox setting selects the SDK `SandboxAgent` and one Unix-local session for the
active run, including Handoffs and approval continuations. Its manifest grants read-only access
to the canonical worktree. Worktree paths ending in whitespace are rejected because the SDK trims
them. A worktree at or under `/workspace` uses a distinct SDK virtual root so the host grant resolves
to the assigned worktree. The model-facing `read` resolves worktree permissions first and reads
text through the SDK session. It rejects canonical paths ending in whitespace because the SDK
trims them before resolving the file. SDK `filesystem.configureTools` offers the existing `apply_patch`
FunctionTool for approved, grant-checked edits. Files and Diff use the same worktree. Skills keep
their existing admission checks and tool names. The Sandbox graph omits `Agent` and
`background_command`. Separately opened chats and user-configured MCP services retain their own permissions.

Sandbox `bash` uses the SDK session's `exec` with a fixed non-login shell, the canonical worktree
and the SDK environment. Bare `pwd` runs directly. `rm -- <relative-file>` requires approval for
that call and accepts one existing regular worktree file. Path components use ASCII letters,
digits, `.`, `_` or `-`. Traversal, `.git` components and symbolic links are rejected. The target
and approval are checked again immediately before execution. Other shell forms and malformed inputs
return errors before a process or approval dialog. The existing `timeoutMs` is capped at one second
for these commands. SDK 0.21.0 first registers a long-running process when execution yields. A yielded
process is stopped before the tool settles, including when Stop arrives during the initial wait.

Unix-local shell commands run with host permissions. The manifest omits host credentials. Unix-local
requires macOS or Linux and trusted Python 3. Runtime failures settle with their cause. Stop revokes
the grant before abort, and settlement awaits SDK session disposal. Approval checkpoints contain
application state. Restart creates a fresh runtime with the current grant. Chat mode changes require
an idle session.

The ordinary `apply_patch` FunctionTool describes its SDK 0.21.0 headerless V4A format in the
model-visible parameter schema: existing-file sections use `@@` followed by remove/add/context lines;
new-file lines all start with `+`. Executable examples accompany the format. `original` is the entire
exact file text, or null only for creation. These descriptions do not change SDK parsing, grants,
approval or atomic replacement.

Approvals use SDK `needsApproval` and application dialog cards. Questions use the same resumable SDK
interruption boundary with the retained portable questionnaire schema/result formatter and question
renderer. Only the question is resumed after its owned answer; a composer steering input can supersede
that question with the existing deferred/chat acknowledgement. It cannot approve another tool.
A deferred or abandoned question result carries `terminate`. The Agent's SDK `toolUseBehavior`
makes that result the run's final output, so the model is not called again; the superseding input
starts the next run.
Responses bind session, run, tool call, interaction and revision. Identical decisions return their durable
receipt; stale, missing-call, conflicting and cross-session replies fail before execution.

Outbound transcript snapshots, session events, approval tool input and child transcript reads project
inline images through `images` into HTTP references. Children register images under their owning parent
chat. The projection never mutates canonical transcript, model history, queue inputs or checkpoints.
A known serialized image-result envelope is normalized only for display; its textual `isError` or
`terminate` cannot become execution flags. Actual object results keep their explicit SDK tool flags.
The image source reads only this host's attached, live sessions and refuses closing/deleting sessions
or closing workspaces. Composer queue restoration deliberately returns inline images for resending.

The shared SDK extension-UI display projection strips terminal escape sequences from title/message
fields, including notify text, after child-title prefixing and image-related message reconstruction.
Live publication, pending-dialog reads and state/transcript summaries use the same projection.
It removes complete CSI/OSC/DCS/APC and related ESC/C1 sequences. For a broken sequence it drops only
the control byte and preserves the following text; ordinary Unicode, tabs and newlines remain.
The shared plain-text scanner preserves the required incomplete-sequence behavior
(see the shared module's display text contract). This is display-only. Canonical approval
requests, toolInput/arguments, RunState/checkpoints, ordinary transcripts/tool output and PTYs keep
original values. MCP select options are exact consent decision tokens and are never rewritten.

Session get/add/pop/clear and public history transactions persist append/suffix replacement together
with operation receipts. Canonical input content, current history membership and summary retirements are
separate. Pop permits re-addition; memory reset clears retirements but keeps transcript and receipts.
Queue admission commits its model item, transcript user message and queue removal in one record.
Queues expose pending/staged input; model-history commit establishes admission. Steering uses public
`RunState.addInput` at an eligible model boundary, stays durable on rejection, and never bypasses an
interaction. Unused steering runs before follow-ups only after normal settlement. Stop preserves queued
input, revokes the grant first, then waits for model and process cleanup.

Trusted checkpoints retain logical run identity, the original extension registrations and declared settings and the
original worktree grant. Close/shutdown saves pending interactions. Attachment builds new tools/controllers
before `RunState.fromString`, and waits for response readiness before returning its snapshot. Approved
completed tools do not replay. Record executor start before effects and its result after completion.
Restart classifies an unrecorded result as unknown, shows it in the transcript, repairs paired model-history
call/results and requires explicit new input. Model requests without resumable interactions become interrupted.
The registry supplies fresh SDK factories and generic argument/response policies; schema and result formatting stay in the extension server half.

Summary generation receives a detached older prefix only after full settlement without a checkpoint or
pending interaction. Retain the whole newest exchange and paired ordinary FunctionTool records. A paired
result that Stop or a run error closed as `incomplete` (the SDK 0.21.0 abort marker, as in its internal
`buildFunctionAbortResult`) can be summarized; only an `in_progress` result blocks. The Go
model's published context budget minus output/system headroom uses the host's captured
`autoSummaryThresholdPercent` (50/75/90, default 75) for eligibility; a save affects the next check and
starts no request. Manual force still bypasses eligibility. UTF-8
serialized bytes provide a conservative internal token upper bound. User-visible counts use actual SDK
request usage, never that byte estimate. A nonempty bounded summary must reduce model history. Commit model
memory, retired IDs, the summary marker and operation receipt against the unchanged revision. Generation,
cancellation, validation and write failures preserve committed history. Replay never regenerates or restores
an old window. New input cancels the summary and waits for cleanup before its Runner starts.

SDK local context is the private JSON-only `Readonly<{ workspaceId: string }>` identity. Root and
background child runs supply it; foreground `Agent.asTool` inherits the parent context and shared usage.
Dynamic instructions validate matching identity and the active grant before returning admitted context.
Services, functions and credentials remain in fresh host closures. Recovery retains public
`RunState.fromString` and checks `state.toJSON().context.context` before approval continuation or any
model/tool effect. Missing, malformed or mismatched identities fail through normal settlement, dismiss
interactions, keep transcript/history/queued input/effect receipts and never automatically replay or
drain the queue. No old checkpoint migration or context override discards restored usage.

`compactSession(sessionId, { operationId?, instructions?, force? })` captures the threshold once before
the existing asynchronous transaction; `force: false` uses that choice and manual force bypasses it.
For example, complete history at 60% of the host budget compacts at 50 and skips at 75 or 90. A matching
`{ workspaceId: "assigned-workspace" }` is the entire local DTO; `{}`, another workspace, or extra keys
fail identity validation. These values never replace a grant. Assertions: `sessionStore.test.ts` —
"Earlier summarizes complete history Default skips, and Later defers Default-eligible history";
`sdkSessionManager.test.ts` — "settings saves request nothing; the next settled check uses the new choice
and in-flight summary keeps it", "dynamic instructions reject mismatched workspace context and revoked
authority before requests", and "identity-only context checkpoints exclude closure services and
credentials while admitted instructions reach requests"; `sdkExecution.test.ts` — "root and detached
context are separate while foreground children share parent identity and usage";
`sessionRecoveryAudit.test.ts` — "unsupported checkpoint identity" cases and "current-format approval
recovery retains identity, original usage and once-only effects".

## Model configuration

`planReviewOutput.ts` owns one fixed public `StandardSchemaWithJSON<PlanReviewOutput>` adapter.
Its input/output schemas describe the same natural optional DTO; synchronous validation delegates to
the contracts guard without effects or transformations. SDK 0.21.0 makes optional wire properties
required/nullable and removes synthetic nulls before that guard. Deterministic public Responses
captures must freeze the converted schema and prove semantic rejection, rather than trusting raw
JSON-schema parsing. Only `childRun.purpose:"review"` selects this output type.

## Scenario: validated independent Plan review

Trigger: the host calls `runSessionChild(parentSessionId, SessionChildRequest)` for Plan review.
It returns `{sessionId,status,output?:PlanReviewOutput,usage}`; ordinary Agent delegation stays text.
New review children persist `outputContract:"plan-review-v1"`. Their accepted output binds
`childRun.reviewOutput:{runId,messageId}` to the exact final-output `AssistantMessage.planReview`.
The existing Session transaction commits payload, binding and event sequence before publishing the
same-ID `message_end` correction or child success. No last-assistant scan or transcript parsing is used.
Review children accept only their initial host prompt. `steerSession`, `followUpSession`,
`nudgeSession`, host notifications and review-fix delivery reject before queue, transcript, checkpoint
or input-state writes; editing/flushing queued input also rejects. Public `promptSession` rejects
review children even before their first run; only `runSessionChild` uses the private prompt core for
the initial host input. Recovery resumes
the owned checkpoint. Another Plan review creates a fresh child. Ordinary child queues keep working.
Only the projected assistant belonging to the last action-free, nonempty response can receive final
correction or run usage. A completed commentary message followed by a tool call is intermediate:
Stop, turn exhaustion or a later model error preserves its complete snapshot and appends a distinct
terminal note. Final DTO/getter/persistence failure still corrects the actual final message by ID,
including when reasoning follows that message.

| Condition | Settlement |
| --- | --- |
| Completed response ID/status and final assistant status, no refusal, settled stream, active grant, valid DTO | Commit typed value; then complete child. |
| Refusal including JSON plus refusal, incomplete/nonterminal output, getter/validation/write error | Fail without accepted payload or review effects. |
| Stop or authority revoked during final validation/persistence | Cancel; no late filing or typed success. |
| Stop/turn limit/model error after commentary plus tool | Preserve commentary ID/content/status/usage; append the later terminal outcome. |
| Additional input to a review child | Reject before any admission write; accepted verdict and parent effects cannot be undone by queue replay. |
| Current output contract checkpoint | Rebuild same adapter; preserve context, approval, grants and usage. |
| Missing/unknown contract on pending review | Explicit failure before model/tool continuation; completed histories remain readable. |

Good/base/bad: valid request_changes is successful computation; approve with no findings is valid;
request_changes with no findings fails. Correct: bind the committed final message ID/run to the consumer.
Wrong: parse clipped child prose, attach to a later reasoning message, or publish success before persistence.
Assertions live in `structuredReviewSession.test.ts`, `sessionStore.test.ts`, `sessionRecoveryAudit.test.ts`
and host `planReview.test.ts`; projection/hydration tests pin same-ID final corrections.
Lifecycle regressions compare the earlier commentary's full snapshot, reject active steering and
follow-up before writes, retain a generic-child queue positive control and file the host finding once.
Wrong: treat every `message_output_item` as terminal, or admit input that fails only during queue drain.
Correct: bind final correction to an action-free response and reject unsupported input at admission.

Only the configured, verified stage-1 Responses target is offered. API keys are host-side and saved with mode 0600 in the DesignRail data directory. Ordinary FunctionTools are used for files and commands; native provider shell/patch/compact endpoints are not required.

`localTracing.ts` owns SDK diagnostics through the existing `sdk-trace` host logger; tracing starts
disabled. Its one processor replaces the SDK exporter and never exports over the network. Enabled
root/summary traces use `groupId=sessionId` and metadata `sessionId`, `runId`, `workspaceId`,
`startNodeId`, plus `parentSessionId` for child sessions. Ended spans retain SDK trace/span/parent IDs,
timestamps, duration and a closed field allowlist: agent/function names, Handoff endpoints, guardrail
name/triggered, generation model and numeric token usage, task/turn usage. Inputs, outputs, instructions,
arguments, results, model configuration, arbitrary metadata/error data and response bodies are omitted.
Allowed text and error messages use the run's shared configured-credential matcher plus MCP token
redaction before a 256-character bound; the whole text is masked when it contains any nonempty
configured key. The execution guardrails retain their eight-character minimum for credential matching.

One observational recorder per host run uses public Runner hooks; native foreground `Agent.asTool`
uses the same recorder with public Agent hooks because SDK 0.21.0 does not expose its nested Runner.
The SDK keeps that child's spans under the parent tool span and trace. A diagnostics-local async
scope captures child session/run/parent identity on span start without changing SDK trace IDs or
parent links. Host-owned Runner invocations clear ambient SDK trace context through public
`withTraceContext(null, ...)`, so detached children and summaries create their own correctly grouped
traces even when launched by a parent tool. No second execution owner or usage recorder is installed. Repeated starts during
approval/resume do not open duplicate lifecycle items. Native ends and Handoffs close their matching
items; host settlement closes remaining items exactly once with success/error/length/cancel/guardrail
(or suspended at a durable checkpoint), then detaches observers. A run-end record carries the final
host outcome even when SDK agent-end preceded host output validation. Existing effect receipts,
approval/Handoff commits and usage ownership stay unchanged. Disabled tracing produces no trace,
span or lifecycle diagnostics; unrelated host logging is unaffected.
Host settlement also ends only SDK traces created in its diagnostics scope through the public,
idempotent `Trace.end`: SDK 0.21.0's non-streaming error path otherwise leaves a started trace open.
The foreground child's native `maxTurns` error handler observes the length outcome and returns void,
preserving SDK error behavior. Its public input guardrail callbacks are observed once and restored
when diagnostics close: arguments/results/errors and execution counts remain with the existing
SDK guardrails, while a tripwire remains identifiable after `asTool` converts the thrown error into
its default tool result. Responses spans expose no model/usage fields with sensitive data off;
their IDs/duration remain available, and SDK task/turn spans carry numeric usage when supplied.

Go requests identify the client as `DesignRail/0.1`. `createConfiguredModel(model, sessionId)` requires the application conversation ID and sends it as `x-opencode-session` through the public OpenAI client's `defaultHeaders`. Every run and approval continuation in that conversation uses the stored session ID, independent of run IDs and credentials. One-shot assistance allocates one UUID for its logical invocation. The fixed `responsesClientSettings` uses public `ModelSettings.providerData.extra_headers` for the user agent because Agents SDK 0.21.0 replaces the client default with its own per-request header. Model discovery sends the same client identity without inventing a conversation. This follows the [Go client requirements](https://opencode.ai/docs/console/go/#where-can-i-use-it), checked 2026-11-11 with Agents SDK 0.21.0 and OpenAI 7.55.0; generic SDK identification or a missing session header can reject a request before inference.

## Scenario: the first SDK workflow

### Scope / Trigger

Stage 1 replaces the execution kernel while preserving the existing workbench and workspace services.

### Signatures

`createSession({cwd,workspaceId,model?,thinkingLevel?})` returns the application session identity.
`promptSession(sessionId,text,images?,messageId?)` admits one input synchronously and returns full settlement.
`abortSession(sessionId)` waits for cancellation cleanup. `getSessionMessages(sessionId,workspaceId,cwd)`
returns `{summary,messages,eventSeq}`. `resolveExtUi(response)` applies an owned decision.

### Contracts

`session.event` is `{sessionId,runId,seq,event}`; `seq` increases within a session. Snapshots carry the
matching watermark. Approval replies contain `{id,sessionId,runId,toolCallId,revision,value}`. SDK history and
transcript are separate fields in the atomic version-2 session record. The verified stage-1 target is
OpenCode Go `/inference/go/openai/v1` with `deepseek-v4.1-flash`: text and ordinary tools, reasoning off,
a published context budget of 1,000,000 tokens and unavailable price. The [provider model catalog](https://models.opencode.ai/providers/opencode-go/) identifies that context window for the selected Go model (checked 2026-11-12); near-limit service acceptance is not claimed. `maxTokens` is a request budget, capped at 8192.

### Validation & Error Matrix

| Condition | Result |
| --- | --- |
| A session already has an active run | Reject the new prompt before another Runner starts. |
| Missing workspace, escaped path, symlink escape or `.git` target | Reject before filesystem effects. |
| Patch original differs from current bytes | Preserve the target and require a fresh read. |
| Cross-session, stale or conflicting approval | Reject; identical decisions cannot execute twice. |
| Stop | Revoke the grant, cancel owned work, then settle cancelled. |
| Failed atomic write | Preserve the prior committed record and revision. |
| Unreadable or older-format session record | Skip it in session lists with a warning; other sessions and host startup continue. Direct attachment of that record still fails. |

### Good / Base / Bad Cases

Base: read a worktree file without approval. Good: approve one patch and command, save their actual
results and correct the streamed final message. Bad: a late approval after Stop must create no effect.

### Tests Required

Agent tests assert real file/process effects, approval ownership, Stop, atomic storage and fixed model
metadata. Store/transport tests assert canonical IDs, final correction, watermark buffering, isolation
and approval hydration. The live stage-1 browser scenario asserts actual bytes, command output, peer
worktree preservation and the displayed Diff.

### Wrong vs Correct

Wrong: infer tool failure from text containing `"isError":true`, or success from a resolved stream promise.
Correct: project explicit per-call executor status and settle only after checking errors, cancellation
and pending approval.


## Scenario: durable sessions and model summaries

### Scope / Trigger

Stage 2 keeps inputs and decisions consistent across model boundaries, disconnects and host restarts.
The Boundary rules above apply to both live and restored execution.

### Signatures

`steerSession(sessionId,text,images?,messageId?)` and `followUpSession(...)` persist queued input.
`updateQueuedMessage(sessionId,messageId,text,images?)` edits pending input; `removeQueuedMessage(sessionId,messageId)`
withdraws it. `compactSession(sessionId,{operationId?,instructions?,force?})` uses the configured ordinary SDK model.
`respondToTool(sessionId,toolCallId,response,{runId,interactionId,revision})` applies one owned response.

### Contracts

Fresh records use `version: 2`; earlier formats are rejected and left unchanged. A single atomic record
contains history, transcript, queue, checkpoints and receipts. Public queue entries are
`{id,text,state:"pending"|"staged",error?}`; admitted input appears once in the transcript. Regular queue
snapshots omit image bytes; SDK checkpoints stay on the host. Successful summary receipts retain SDK usage so
replay and reopening count it once. The `sdkTracingEnabled` app setting defaults to false and selects
only the local metadata processor.

### Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Input ID reused with different content | Reject before admission; distinct IDs may carry identical text. |
| Queued handover fails | Keep the input and visible error; allow pending input to be edited and retried. |
| Missing, wrong or expired interaction anchor | Reject; a valid identical response returns the saved result. |
| Reply arrives before restart hydration | Restore the owned record before checking the decision receipt. |
| Executor started without a saved result | Mark unknown, pair the model history and require explicit new input. |
| Summary generation fails, is cancelled, or has a stale revision | Preserve prior memory and receipts. |
| Summary operation already succeeded | Return its receipt without a model call or later-history overwrite. |

### Good / Base / Bad Cases

Base: refresh restores the same transcript, pending interaction and queue. Good: approve after restart,
execute once, then retry the same reply after another restart. Bad: neither a late reply after Stop nor
an unknown interrupted effect can start another side effect automatically.

### Tests Required

Store/summary tests compare durable bytes on failures and exercise pop, reset, retirements and receipt
replay. Manager/recovery tests force input, Stop and hydration interleavings and assert real effect
counts, ordered event sequences, fresh controllers and frozen extension settings. Focused browser
tests use real Go calls for queues, question answers, SIGKILL recovery and summary fact recall; offline
browser tests retain renderer coverage. Tracing tests enable a non-noop SDK trace and assert zero HTTP.

### Wrong vs Correct

Wrong: acknowledge staging as admission, or clear memory before saving its summary.
Correct: commit the history item and queue removal together; commit summary memory, marker, retired
IDs, usage and receipt together after checking the unchanged revision.

## Agent catalog and role availability

The catalog and the ordinary SDK Agent tool resolve the same built-in, personal, and trusted
project definitions in the same order. The catalog projects display fields and omits the system
prompt and file path. The advertised roster omits globally disabled roles. A new child call and a
queued child entering execution both require the role to be enabled and, for a project role, current
project resource trust. Foreground approval resumes the already-started child by its persisted
tool-call identity and model and still checks current project resource trust. Changing role
availability does not interrupt that continuation. The independent Plan review path has its own
policy.

## Preserved Skills and delegation policies

The SDK replacement keeps the application Skill catalog, source discovery, two distinct project trust
and resource-trust gates, per-skill/group/workspace decisions, search ranking and bounded prompt
listing. Skill metadata/content uses application-owned types and the existing YAML parser; it does not
load a pi runtime, pi credentials, plugins or session files. Personal application Skills live under
`<dataDir>/skills`, project resources under `.raildesign`, and external-agent content roots retain their
existing enable/acknowledgement policy. Skill paths are checked against their declared canonical roots.
CLI and desktop stage the build-support Skill assets and call `setBundledSkillPaths(skillsDir)` before
host startup. This selects physical `host` and registry-extension content roots without installing
extension factories; disabled extensions still withhold their Skill assets. Source runs use the
existing package content roots.

`skillTools` loads applicable ancestor `AGENTS.md` files in parent-to-child order.
The prompt also requires applicable nested instructions before a directory change.
Instruction files have a combined 128 KiB limit.
Symbolic links cannot supply workspace instructions.

`skill_search` uses the current admitted catalog.
`skill_read` reads a selected Skill body or a resource in that Skill directory.
Each call checks current trust, enable policy and the run grant.
This separate read boundary permits approved Skill directories outside the worktree.
Ordinary workspace reads retain their existing boundary.
The host expands `/skill:name` from actual admitted content.
Manual-only Skills require an explicit user command before model access.

Child execution uses SDK `Agent.asTool()` for foreground delegation and the same session owner for
background tasks. Separate durable child records retain definition, parent, tool-call identity,
approval checkpoint, completion-delivery state and transcript. Current enable policy, project trust
and concurrency limits apply on admission and execution. Definition tool and Skill allowlists narrow
the actual SDK graph; children have no MCP or nested delegation tools. Standalone-chat children have
no Spec tools. Foreground initialization, restoration and invocation failures release the child slot.
Only the manager's real SDK records supply child ownership; obsolete fake delegation-service adapters
are removed.

Image dimensions, MIME detection and payload/request budgets remain in the pure `imageGuard` module.
Its retained tests validate those rules; the current verified text-only model does not enable vision.


## Requirements understanding tools

An ordinary chat in a resource-trusted worktree can call the requirements tools when
`requirements-workflow-host` (3.0.3 or later) is admitted from the user's DesignRail application Skill directory.
The tool launches the installed Python workflow and uses the admitted companion `json-exporter`.
Project instructions and manual Skill aliases do not authorize execution of Python code.
Sandbox, specialist and child agents do not receive these host tools.

The chat's atomic session record binds the Python session to its existing workspace ID and cwd. The
tools pass caller-local paths and no model-supplied session IDs to the workflow. Python owns drafts,
source records, the current presentation, and the final document/receipt and delivery. The host
owns the source of current user text. A decision applies to the last assistant message with visible
text in the immediately preceding turn. Trailing thinking or tool rows do not supersede a display.
When apply returns `required_user`, the SDK ends the turn with the frozen review from DesignRail
instead of making a further model request. The host publishes the review through the normal
guarded assistant transcript and records its message ID only on successful settlement. A rejected
draft returns its error to the model for repair. The draft's question targets must be exact eligible
requirement IDs or zero-based operations that produce a requirement. For an explicit re-display
after resume or a partial decision, the assistant refers to the frozen ID and DesignRail appends
the same review to its reply. Cancellation, failed output, ambiguous replies, stale references,
and other chats cannot create a decision. Resume reads runner state. The SDK worktree grant
bounds the subprocess and excludes provider secrets. Apply, decide and export each supply the
admitted exporter root to the runner, including automatic delivery of a refreshed pair.

## Formal concept scheme tools

The same trusted worktree and application Skill admission used by requirements understanding
govern formal scheme generation. One native workflow tool runs per chat, including the upstream
requirements tools. The current requirements binding supplies the exact committed document and
receipt. Only actual user messages authorize start, revision, review or delivery. New baseline
versions require explicit rebinding and same-identity validation by the scheme runner. The native
tools preserve the full runner view and verify any paged reference before use.
For first drafts, DesignRail asks the model to call `scheme_stage` immediately with only the
functions supported by the confirmed baseline. Each receipt suggests one missing shared field,
then one missing candidate field, and supplies guidance for that field. Explicitly requesting
continuation can include a colon and drafting instructions. Review and delivery require
their own exact authorization.
The author can discard an unpublished candidate saved under a mistaken key. Each stage returns
the current content digest and missing fields. DesignRail retains this progress with the bound
session. `scheme_apply` takes the draft binding and exact staged digest to validate and publish the
assembled design. After a validation error, the model can replace the affected fields and submit
the new digest. With a current design, the runner supplies a revision template. The model sends only replacements against its bound revision, using stable
candidate and item IDs. DesignRail forwards the submitted bytes. The shared runner applies the
changes to the frozen design, records their impact and validates the complete result before publishing.
The full draft view is accompanied by a read-only projection of confirmed hard constraints, with
the exact statement for direct constraints, the distinct baseline target criterion (including null),
and the definition locator used for baseline-backed quantity facts. Draft guidance preserves
required keys and retains multidimensional values and ranges in operating-context text.
Checks use their exact target conditions and record missing evidence as unknown. An initial concept
can leave analyses empty. A revision of an existing candidate retains its identity.
Changed conclusions need reassessment before the runner can publish a review. Analysis inputs refer to candidate parameters
or assumptions, or use exact source locators. Unknowns referring to candidate-local data belong
to that candidate. A rejected parameter fact returns targeted repair guidance for that parameter
while preserving the runner's error and the draft's operating context and checks. The host's
frozen review supplies the user-facing presentation.

DesignRail persists the scheme session, run and revision with the current state fingerprint,
upstream identity and active draft, pending or committed boundary. A finished apply publishes
the frozen presentation through the guarded assistant transcript. Review binds a real user
decision to the preceding visible message, presentation digest and candidate version. Only
review is available, and the returned formal pair must authorize no downstream candidates.
Status queries never invoke scheme resume, which may apply an on-disk draft. Explicit redisplay
uses only a previously published frozen review that is still current.

Formal JSON delivery is a separate user request. The host stages the runner's export, verifies
that it came from an internal commit and agrees with the recorded pair, and publishes the exact
read-back bytes atomically to the worktree. A mismatched or uncommitted export is never published.

## Preserved MCP management

Configuration validation, fingerprints, CRUD, per-project approval/overrides, logs/redaction and status
projection remain independent of the runner. HTTP uses the pinned SDK's public `MCPServerStreamableHttp`; stdio implements public `MCPServer`
with an owned process transport and the official MCP client's public framing so redacted stderr remains available. Management creates an owned transport, never
another model or a Pi session. The official MCP client handles discovery/DCR/PKCE with an owned token
store; callbacks and pasted replies bind to flow state and client ownership. Token files use 0600
under the application data root. Model credentials are not inherited by stdio processes; explicit MCP
authorization providers resolve only against current application model configuration.

Probe cancellation waits for its callback listener, connection and sign-in lock to close. Session
teardown invokes host-injected `setSessionResourceCleanup` before detachment; failure leaves the
session attached for retry. This avoids a dependency cycle with MCP connection state. Reconciliation
uses current project trust and exact entry fingerprints, and generations reject stale status results.
Local stdio and HTTP OAuth fixtures validate transport behavior without a live model or external login.

The SDK graph composes current admitted MCP FunctionTools and deferred `tool_search` results. Consent
uses owned SDK interruptions with once, chat and project choices. Saved decisions retain the complete
configuration fingerprint; recovery rechecks it before resuming. Stop closes owned connections and
process trees, while idle reload reconciles them before rebuilding tools. Search failures mark the call
failed even when SDK validation hides callback details. Remote error text is redacted and UTF-8 bounded.
MCP execution and consent regressions run through the actual SDK session manager.


Resource aggregation accepts explicit current snapshots and a validated application scope. It preserves
all live records, limits the visible finished window, merges the application's resource archive without
letting derived interruption replace an owner's settled outcome, and excludes foreign parent records.
The caller must establish live workspace/session authority before selecting the scope; these helpers
validate id syntax and record ownership, and grant no live resource authority. Command archival records real final output separately
from public summaries; only teardown's own cuts are marked interrupted. Child lifecycle archival
requires both workspace and parent ownership. `resourceIdentity` validates bounded plain application
ids before these helpers build or access archive paths.

Skill retained-tail analysis is separate from compaction execution. `compactedSkills` consumes the
owned transcript and an explicit committed cut supplied by the compaction transaction. Complete
retained loads suppress carryover; partial, truncated or gapped reads do not. It reads no runtime
journal or `firstKeptEntryId`. The visible compaction summary alone cannot establish the retained cut.
The fresh E2E evidence fixture reads only owned transcript objects; it contains no file-discovery or
`/compact` driver. Repeated compaction and real-model Skill compliance remain separate acceptance work.


The retained title service uses `renameSession(...,{onlyIfUnnamed:true}):Promise<boolean>` for an
atomic conditional title write. The check and write share the attached session entry; an automatic
proposal cannot replace a manual title or a previously accepted automatic title. The normal manual
rename operation remains unconditional. SDK title tools use the host-injected service and recheck
the run grant before applying a title or workspace proposal. The service strips terminal escapes
before validating and saving the title. State pushes and session lists project titles as plain text
without rewriting stored records.

## Stage 3 child and resource execution

The SDK manager composes all enabled tools through the existing run grant and receipt path.
Foreground child tools use public `Agent.asTool()`.
Background children use the same SDK manager as their parent, with a separate session record.
Child records store parent identity, definition, task, tool-call identity and completion delivery state.
Child definitions control their tools, selected Skills, extensions and workspace instructions.
The manager applies these limits when it builds the actual tool graph.
Model-generated child tasks cannot activate manual Skill commands.
A parent owns each child and background process.
Stop revokes owned grants before cancellation and waits for cleanup.
Child creation rechecks the parent grant after each asynchronous admission step.
Normal parent completion does not cancel background work.
Resource history and child transcripts remain application-owned.
The parent displays one pending approval at a time.
Its own interaction takes priority; pending child requests keep their original identity in child records.
Child usage adds each model response once, including responses before an approval.
Restored interrupted effects never execute automatically.
The child definition and model-selection helpers contain no Pi executor or dependency.

### Scope / Trigger

Use this graph for parent prompts, foreground delegation, background work and independent Plan review.
Reuse the existing session record, grants, interaction receipts and resource archive.

### Signatures

`reloadSessionResources(sessionId, workspaceId, cwd): Promise<void>` validates and rebuilds an idle graph.
`runSessionChild(parentSessionId, options)` returns the owned child ID, status, text and usage.
Resource and transcript readers require the workspace and owning parent session.

### Contracts

`Agent` and `get_subagent_result` retain their application tool names and child-session IDs.
`background_command` uses `action: start | list | output | stop` and an owned command ID.
Full structured tool details go to transcript/UI storage; bounded content text goes to the model.
MCP decisions retain their configuration fingerprint and original call identity across recovery.

### Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Wrong parent or workspace | Reject before effects or transcript access. |
| Reload while running, awaiting input, recovering or owning live work | Reject without changing the current execution. |
| Stop while a child session is being created | Recheck the grant after creation; terminalize the child without a model call. |
| Child approval pauses and resumes | Preserve the same call, execute once and add only new usage. |
| Disabled Skill, extension or stale MCP configuration | Exclude or refuse the tool before execution. |

### Good / Base / Bad Cases

Base: a foreground child returns its separate transcript and final text. Good: a background command
survives normal parent completion, then parent Stop terminates it and retains its output. Bad: a late
creation or approval callback after Stop cannot admit new execution.

### Tests Required

`sdkExecution.test.ts` checks actual SDK dispatch, owned effects, approval restart, concurrency, usage
and Stop during admission. `host/planReview.test.ts` boots the real host to check registration, routes,
failure publication and fix delivery. Browser/live tests check user controls, refresh and actual models.

### Wrong vs Correct

Wrong: count a package rename or a directly invoked factory as proof of product integration.
Correct: trace host startup and UI admission through SDK dispatch to a persisted effect and cleanup.

## SDK Handoffs

A Handoff transfers the current conversation to another declared agent inside the same session,
Runner and `PersistentSession`. It is distinct from `Agent.asTool` delegation: a child returns its
report to its parent, while an accepted Handoff target answers the next user input itself.

`handoffGraph.ts` owns the declarative graph. Sources are the personal `<dataDir>/handoffs.json` and the
trusted project `<cwd>/.raildesign/handoffs.json`; a trusted project document replaces the personal one
as a whole. An absent document supplies no Handoffs. A present malformed document is an error and does
not fall back to another source. Untrusted project resources never supply a graph or its definitions;
the project-trust inventory lists the file as `handoffs`. Discovery grants no edge and there is no
default graph. Example:

```json
{
  "version": 1,
  "rootTargets": ["analyst"],
  "agents": [
    { "definition": "analyst", "targets": ["builder", "$root"], "history": "all" },
    { "definition": "builder", "targets": ["$root"], "history": "without_tools" }
  ]
}
```

Each node names an existing agent definition and declares its outgoing edges and history policy.
`$root` is the reserved chat agent (`DesignRail`); it is not a definition. The resolver rejects unknown
keys/versions/policies, duplicate or reserved nodes, the chat agent's name, self or repeated edges,
undeclared targets, missing definitions and nodes unreachable from root. Cycles are allowed and share
the root run's `maxTurns`. Composition rejects generated transfer tool names that collide with
another tool of the same agent before any model call.

`history` selects the model-visible view for the current agent; it is history selection, not redaction.
`all` keeps the admitted input. `without_tools` (`withoutToolHistory`) removes function call/result pairs
whose call the current agent did not make in this run, the reasoning that opens such a call, and
`summary_*` items whose receipt is not `toolFree`. Its own current-run exchanges are kept by call ID from
the public `RunState.toJSON().generatedItems` attribution, so pairs stay complete. One implementation runs
in the shared `callModelInputFilter` at every model request: after a transfer, on the next run
admission, after an approval resume and with summaries in history. The SDK handoff `inputFilter` is not
used: it replaces the run continuation for every later agent of the run, so an `all` agent after a
`without_tools` agent would lose history, and the 0.21.0 `removeAllTools` helper is not exported by
`@openai/agents`. `PersistentSession.history`, effects and the transcript keep every record. A summary
receipt records `toolFree` when its prefix has no tool records and no tool-derived earlier summary;
an absent value is not proof, so restricted views omit that summary.

`createSession` captures the resolved graph (definition data, edges, policies and source) for root
chats into `SessionRecord.handoffs` with `activeNode: "$root"` and an empty transfer list. Children,
review children and chats created without a graph have no `handoffs` field and stay ordinary. Every
graph build and every transfer recompares the current resolution under current trust with that
snapshot; drift, removal or revoked trust fails the run before any model request or effect. The
snapshot is never replaced underneath a stored continuation; the user restores configuration or
starts a new chat.

`buildSessionGraph` builds every node over the same run grant and connects public SDK `handoff()`
objects with a validated `{ reason }` input. Destination and authority come only from the configured
edge. Targets use their definition instructions, tool and Skill allowlists, extension opt-in and
model resolution; they never receive the child BRIDGE prompt, workspace actions, child management
or MCP. Only non-interactive children lose the question tool. Delegated and review children have no
Handoffs.

`onHandoff` rechecks the run grant, current owner, declared edge and graph identity, then records
only a provisional transfer. The SDK emits the target's synchronous `agent_start` before its model
request; that listener rechecks authority and commits `activeNode` plus the transfer record
`{id,runId,from,to,reason,timestamp}` through the synchronous Session update. A write failure or a
late callback after Stop throws there, so the target never runs. The HA6 Stop test in
`sdkHandoffs.test.ts` depends on SDK 0.21.0 emitting `agent_handoff` between `onHandoff` and the target
`agent_start`; it asserts that order, so recheck it when the SDK version changes. `callModelInputFilter`, dynamic
instructions and `agent_tool_start` reject an agent that is not the committed owner. A failed target
remains the owner; Stop does not change it. The next prompt and drained queue input start at
`activeNode`.

The same write appends the transcript row `custom/agent-transfer` (`AgentTransferDetails`: transfer ID,
from/to agent names, reason) and advances `eventSeq`; its `message_end` and the new state are published only
after that write. Record validation rejects a transfer row without its receipt. `visibleState` derives
`SessionState.activeAgent` from `activeNode` (root is `DesignRail`), so live state, summaries and reopen
agree. Assistant text, reasoning and tool-call messages carry `agent` from the SDK item or the
`agent_updated_stream_event` author; ordinary chats carry neither field. Handoff call/output items are
shown only through the transfer row. A target's approval title starts with its node name.

Pending approvals, questions and decisions store the originating `agentNode`. Recovery rebuilds the
full graph and passes the root agent to `RunState.fromString`, so every reachable agent resolves by
its unique name. The restored current agent and each interruption must match the saved owner and
node; a mismatch fails before continuation and completed effects never replay.

## SDK guardrails

`guardrails.ts` owns one interface: `loadGuardrailPolicy({cwd?,dataDir,projectTrusted,credentials})`
returns public SDK definitions (`agentInput`, `toolInput`, `toolOutput`), each named after the rule it
enforces, the host output gate `output: {window, match}`, and `redact(text)` for local diagnostics.
The redactor reuses the same configured-credential matcher and MCP redaction. It reads `<cwd>/.raildesign/guardrails.json` when the project's resource trust is
granted, otherwise `<dataDir>/guardrails.json`; the project file replaces the personal one. An absent
file adds no rules. A malformed, oversized (64 KiB), invalid-regex, duplicate or reserved-name document
throws `GuardrailConfigurationError` citing the file, so the run fails before any model request. An
untrusted project file is ignored and listed by project trust. Format: `{version:1, rules:[{name,
stages:["userInput"|"finalOutput"|"toolInput"|"toolOutput"], literal | regex}]}`; patterns are at most
1024 characters, regexes compile with `u`. `finalOutput` rules accept literals only; a regex there is a
load error. `outputInfo` carries only `{rule}`, never matched text.

The built-in rule `secret` is always on. It matches configured credential values of at least eight
characters (endpoint keys from `configuredModelKeys`, the web-access key, and from `mcpCredentialValues`:
secret-named MCP headers/stdio env, OAuth client secrets and saved OAuth tokens) in tool arguments, and
those values or `TOKEN_LITERAL` (exported from `mcp/redact.ts`) in tool results. The manager collects
these values from their owners once per run (`runGuardrails`).

The manager loads the policy once per run in `buildSessionAgent` (`run.guardrails`), so root, Handoff
targets, foreground and background children share one policy, and an edited file applies to the next run.
Agent input guardrails use `runInParallel:false`: a user-input match ends the run as stop reason
`guardrail` with `AssistantMessage.guardrail` and completion failure `guardrail`, before any model
request; the SDK does not persist the blocked input to model history. Only the newest trailing user
messages are examined, so older history cannot re-trigger. `attachToolGuardrails` sets every
FunctionTool's guardrails, and both Runners set `toolExecution.preApprovalInputGuardrails`, so a rejected
call never shows an approval card and never runs. A rejection is SDK `rejectContent`: the model and model
history get the rejection or withheld result message and the run continues. G3 uses the same configured
credential matcher on tool arguments before writing the tool card or session history. Matching arguments
are stored as an empty object with the original call identity. History writes omit provider metadata on
that call and use the same normalization when reconciling the SDK's original items. The tool record carries
`guardrail:{stage,rule}`; a rejected call is an error, a withheld result keeps its original content on
the host transcript and card, while the effect receipt and repaired history keep the withheld text.
Summaries, Handoff views and restored checkpoints read model history only. Guardrails never grant,
approve or replace grants, containment or approval.

G4 is a host output gate, not SDK output guardrail integration; the D01 output-guardrail part stays open.
SDK 0.21.0 refuses to restore a saved approval state when an agent has an output guardrail and a
non-default `toolUseBehavior` (`runner/blockedOutputPersistence.mjs:184`, `runState.mjs:3063`); the
question terminate rule needs that function. `output.match` applies the built-in `secret` output matcher
and the `finalOutput` literals; `window` is the longest text a match can need (longest credential or
literal, or 20 for token shapes). Three seams use it, in this order:
1. Stream projection keeps the full text of the streaming message in `run.streamText` and publishes and
   saves only the prefix older than `window - 1` characters, so live text lags by at most that much. The
   message-end item (deltas, no deltas or refusal) and each reasoning item are checked before
   `appendMessage`/`message_end`. A match revokes the grant, aborts the run and settles stop reason
   `guardrail` with the published safe prefix only. The held tail is flushed only by a successful message
   end that passes the full-text check; Stop, error, length, cancel and guardrail ends drop it unsaved.
2. `PersistentSession.historyGuardrails.checkOutput`, installed per run and cleared on every settle path, refuses SDK
   `addItems`/`applyHistoryTransaction` writes whose assistant message or reasoning text matches
   (`GuardrailOutputBlockedError`); history is unchanged and the run settles as `guardrail`. A
   `replace_suffix` checks only replacement items not already in the expected suffix, so a later stricter
   rule never refuses older history. This closes the case where the SDK writes the turn before the host
   sees it. Tool items use the separate G2/G3 rules.
3. The summary callback checks the generated summary before the transaction saves it; a match throws
   `GuardrailOutputBlockedError` naming the rule and keeps prior history.
A blocked foreground child records the guardrail stop in its transcript and returns an error result to
its parent. The user input and text that does not match remain outside G4.

## DeepSeek web access

`webAccess.ts` owns the separate DeepSeek key and the Search/Fetch clients.
The key lives in owner-only `web-access.json`, outside AppConfig and model configuration.
Status contains only `configured`.
Each request uses the current key and a fixed DeepSeek endpoint.
Redirects are rejected.
The request deadline is 30 seconds.
Response reads stop at 1 MiB and model text stops at 32 KiB.
Search returns at most ten results with bounded title and summary text.
Fetch accepts HTTP(S) URLs without userinfo.
Provider errors do not expose response bodies or credentials.
Cancellation stops response reads before a result can return.
SDK extension factories use injected service callbacks, not host imports.

## SDK Plan tools

The manager composes seven `@thinkrail/todos` FunctionTools with the session identity and current run grant.
`TODO_RULE` describes Plan creation and maintenance. Structured tool details remain in the application
transcript; the model receives bounded text. The existing TodoStore owns all Plan mutation.

## SDK Spec tools

Repository sessions compose eight `@thinkrail/spec-graph` FunctionTools and SPEC_RULE. Standalone
chats receive neither. Create, update and delete use SDK approval interruptions before filesystem effects;
all tools recheck the run grant and preserve the core's path and frontmatter validation.

## SDK background work and resources

`backgroundCommands` owns bounded noninteractive process execution through the subprocess module.
The manager retains output in resource history, publishes lifecycle changes and delivers each completion
once at a safe boundary. Normal parent completion leaves background work running. Parent Stop revokes
owned run grants, cancels child admissions, recursively disposes child-owned commands and waits for
cleanup, including commands retained by already completed children. Single-child and stop-all controls
use the same cleanup; a completed child keeps its settled status. The child completion gate stays closed
through process settlement, preventing a cleanup-generated result from starting another run.

Resource routes validate workspace and owning parent identities before reading output, child transcripts
or applying controls. Historical text and archived records grant no process authority. `ChatView` uses
these routes for the existing resource dock/inspector. Child sessions stay out of the ordinary chat list;
foreground SDK usage and background child usage are each counted once. Reload refuses active owned work.
SDK tests exercise approval restart, once-only completion, grant revocation during admission, actual
child tool graphs and OS process termination. Browser and live gates validate the composed controls.

The parent resource view includes commands owned by its direct children in the same workspace.
Command summaries retain their actual owner session ID. The manager derives this authorized owner set
once for resource queries, output/history reads and Stop routing; unrelated child archives are excluded.
Child command completion is delivered once to the parent's safe boundary and never restarts a completed
child. Historical output lookup uses the complete owned history, independent of the visible 20-row window.
Cleanup waits for all outcomes before reopening completion gates, including failed cleanup attempts.

## SDK tool failure projection

Function factories use `errorFunction: null` so SDK validation and executor failures reach the existing public `invoke` boundary with the original call identity. That boundary stores bounded structured error content and marks executed effects failed; malformed arguments rejected before executor admission have an error transcript result and no effect receipt. It rethrows after Stop or grant revocation. Successful text that resembles an error stays successful; structured `isError` results remain errors. MCP keeps its own redacted, bounded error projection.

Plan, Spec and visualization factories validate their TypeBox arguments at their public invocation entry.
A shape error raises the tool's argument error before SDK execute starts. The SDK still handles malformed JSON and approvals.
`extensionToolInputs.test.ts` observes both rejected and admitted calls at the real SDK execute callback.

Factory service contracts carry current grants and owned application services, without a second failure callback. `sdkSessionManager.test.ts` covers invalid Skill and workspace arguments, malformed Todo/Spec JSON, nonzero commands, successful error-shaped text, and Stop during executing tools.

## SDK model retry and kept tool defaults

`responsesClientSettings.retry` is the only model retry owner, so root, child, summary and one-shot runs share it. A restored run rebuilds the agent and receives the runtime-only policy again. It allows five retries with exponential backoff (1 s start, ×2, 16 s cap, jitter) for network errors, HTTP 408/409/429/500/502/503/504. A provider retry-after hint sets the delay but is capped at 16 s, because the SDK otherwise waits the full hint (an hour-long quota hint would hang the turn); a hint alone does not make another status retryable. The OpenAI client keeps `maxRetries: 0`, so one owner counts attempts. The policy never sets `approveUnsafeReplay`; the SDK refuses a retry after streamed output or abort, and Stop aborts the backoff wait. After the last attempt the turn settles through the normal error record. Test-only live fixtures set `retry: { maxRetries: 0 }` to keep their request ledgers exact.

These SDK defaults stay unchanged:

- Tool concurrency: all calls of one turn start together; writes already wait for approval.
- `toolNotFoundBehavior: raise_error`: a call to an unknown or disabled tool fails the run.
- `toolNameCollisionPolicy: warn`: MCP tools use namespaced names that are checked for uniqueness.
- No tool `outputSchema`: no consumer needs typed tool output.

Direct MCP tools reject non-object arguments before transport; the MCP server validates its own input schema. A disabled subagent or MCP tool refuses an approval or fails a restored run before its effect. Tests: `sdkSessionManager.test.ts`, `sdkExecution.test.ts`, `sdkCapabilities.test.ts` and `modelConfiguration.test.ts`.

## Retained workspace actions and host notifications

Top-level SDK sessions expose `start_workspace` and `workspace_status` through host-injected application
services. Child definitions cannot acquire them. Creating an independent workspace uses the current
run signal; a captured tool checks its grant before admission and after asynchronous work. The new
workspace runs independently once its kickoff is accepted. `continue_in_workspace` is available only
in a standalone chat and applies only a host-requested continuation, through the same grant and signal.
The host also checks the actual run input ID against its operation; a stale queued request cannot
fulfill a newer continuation after restart or change its target project.

Host continuation cards and manual TODO notifications use the existing durable internal follow-up
queue. Their stable IDs are recorded in SDK model history once; they do not create user transcript
messages or visible queue rows. A nudge never bypasses a pending question/approval, and running work
receives it after normal settlement. An idle nudge starts one SDK run. Identical retries join the saved
input; conflicting content for its ID is rejected. Stop discards internal notifications before settlement
while retaining user-authored queue entries. Visible custom cards remain in the transcript.
Clearing the visible input queue withdraws only user-authored inputs, preserving host notifications.

MCP resource listing, template listing and reads share current MCP connections, trust checks and exact
configuration fingerprints. They use public SDK resource APIs and the existing output store; they do
not start another transport owner. Stale grants or removed access prevent subsequent resource calls.

Artifacts use canonical application session events, attributed through the existing child parentSessionId. The SDK instructions put deliverables in the workspace context, retaining the same path for updates; atomic apply_patch remains unchanged. No second runtime or Pi guard is installed. Checkpoint context stays exactly `{ workspaceId }`. Visualize receives a run-scoped host file capability, not a serialized service.

getSessionOwnerId(sessionId) exposes the current attached session's openable parent ID for host-owned artifact attribution. Runtime services remain closures; checkpoint context remains exactly {workspaceId}.
