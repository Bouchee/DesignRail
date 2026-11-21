---
id: module-extension-api
type: module-design
status: draft
title: Host extension contracts and pure renderer helpers
parent: architecture
depends-on: [module-contracts, module-locales]
references: [module-thinkrail-extensions]
---

## Responsibility

The source-only host extension contract, independent of presentation components and host state. The
browser and server descriptors compose capabilities without importing either application's internals.
The host retains registration, lifecycle and ordering; `define*` helpers preserve the supplied descriptor.

## Boundary

- `./web` exposes `ToolStatus`, `ToolRenderProps`, `ToolRenderer`, `ToolSummary`, `ToolChrome`,
  `ToolProminence`, `ToolWidth`, `ToolRegistrationOptions`, `ToolInteraction`, `ToolInteractionState`,
  `ToolPlacement`, `WebExtension`, `GlobalOverlayProps`, `ExtensionCommand`, `ExtensionChord`,
  `ExtensionShortcut`, `ExtensionShortcutKey`, `defineWebExtension`, and the pure argument/result readers from `toolHelpers` and `toolResultContent`.
- **Images are references.** `parseToolResultContent(result).images` returns `contracts`' `WireImage`s,
  in block order.
  - A host reference (`ref` plus optional `width`/`height`) is accepted when its `ref` lies under
    `IMAGES_ROUTE`.
  - An inline block is accepted when its `data` is non-empty.
  - Either kind must have one of `ACCEPTED_IMAGE_TYPES`.
  - Extension renderers never load image bytes themselves: the chat's common result layer renders every
    image (#1180).
- **Interactive tools.** A tool whose `execute` waits for the person's response is *interactive*. The
  contract is tool-agnostic on both sides and keyed by `toolCallId`; the host learns a tool's name only
  from the two declarations below:
  - server: `ServerExtension.interactiveTools?: Record<toolName, InteractiveTool>` names the tools whose
    calls wait, so the host can repair a call left dangling by a restart (it writes the pending marker,
    not an error) and derive needs-input from a transcript it is not live on.
    `InteractiveTool.validateArgs?` validates a call before the host publishes its interaction; `parseResponse?` validates the response against the original call. Those hooks stay extension-owned.
    `InteractiveTool.describeResponse?(args, response)` returns the model-facing text for a response
    delivered **after a host restart** (the only path where the tool's own `execute` is gone); `undefined`
    or no hook ⇒ the host writes a generic preface plus the response as JSON. Live responses never pass
    through it: the tool formats its own result.
  - web: `ToolRegistrationOptions.interactive: true` asks the host to fill `ToolRenderProps.interaction`
    for that renderer; `dock: true` (meaningful only with `interactive`) also asks the chat to render a
    call the host awaits in its interaction dock above the composer rather than in the transcript. Docking
    is opt-in because only the extension knows its renderer can live in a height-capped panel.
  - **Pending marker.** A result whose `details` is `{ kind: "ack" }` on an interactive call means "the
    response is still pending": the host writes it on restart repair, and a tool returns it (with
    `terminate: true`) when `awaitToolResponse` resolves `deferred`. It is the one shape both sides read
    (`contracts`: `isToolResponsePending`); a tool must not use it for a real result.
- **Artifact tools.** `ServerExtension.artifactTools?: Record<toolName, ArtifactTool>` tells the host which
  files a successful call put in front of the person (`presented(args, details)`) and which of them the
  person chose (`picked(args, details)`), as raw path strings the host resolves. The host feeds them to
  its artifact index and never learns a tool's argument shape itself; a failed call counts for nothing.
- `ToolRegistrationOptions.width` (`ToolWidth`) is `"column"` by default; `"content"` lets the chat grow
  the renderer's frame past its text column to the content's width, up to the pane, while the user fits
  chat to the pane. It is opt-in because only the extension knows its content reads better wide; the
  geometry is the chat's ([[submodule-web-chat]]).
- `ToolRenderProps.interaction` is optional. The host fills it for every renderer registered
  `interactive`. It carries:
  - `state`: a `response` (`unknown` — the response delivered outside the tool result after a host
    restart, or the final result's `details` when it is not the pending marker), plus `superseded`,
    `ended`, and `accepting` — whether the host is waiting for this call's response right now (a call the
    host is not waiting on, such as a same-name tool from another package, renders but cannot respond);
  - `respond(response)` — the value travels to the tool as is; the tool validates its shape;
  - the chat's `focusScope`, so the card claims attention focus once per chat mount;
  - `prepareLayoutChange`, which keeps the reader's place when the card changes size;
  - `focusComposer()`;
  - `placement` (`ToolPlacement`) — `"dock"` for the live copy in the chat's interaction dock, `"stub"`
    for the transcript row while that copy is docked, absent anywhere else (the plan page, a call the
    chat does not dock);
  - `hostProtocol` — the connected host's protocol version, so a renderer can withhold an affordance an
    older host would not understand (the app's `supports*` gates, handed through tool-agnostically).

  Without it, a renderer shows the call read-only from `result`, as in a subagent transcript. The
  renderer stays props-driven: it never reaches the chat's contexts, store or transport. `state` and
  `respond` are the stable contract; the focus/layout members and `placement` are the chat's own services handed
  through and may change with the chat (a renderer must tolerate their absence). Its DOM-typed members
  are the reason the package's `lib` includes `DOM`; the package still never touches the DOM.
- `WebExtension` is `{ name, title?, description?, toolRenderers?, globalOverlay?, commands?, shortcuts? }`.
  Each tool-name entry carries a `renderer` and optional `ToolRegistrationOptions` under `options`;
  `toolRenderers` is optional because a web-only extension renders no tool. `title` / `description` are
  `MessageKey`s for the Settings row of an extension the server catalog lacks. `globalOverlay` is a
  `ComponentType<GlobalOverlayProps>` the host mounts once while the extension is enabled; its props are the
  host helpers an extension cannot import — `isTextEntry(target)`, `activeLayer()` (the topmost open modal
  dialog or menu, else the document), `platform`, and the command channel below — so the SDK stays
  type-only.
- **Commands** are the extension's rebindable keybindings: `ExtensionCommand` is `{ id, title, chords }`,
  each `ExtensionChord` a physical `code`, a display `key` (a `KeyboardEvent.key`-style value, capped like a
  catalog key) and `mod` / `ctrl` / `alt` / `shift` (`mod` is ⌘ on Apple, Ctrl elsewhere). A chord with no
  modifier (a plain key) is allowed and fires only outside text entry; such a command may be rebound to
  another plain key. The host lists the commands in the cheatsheet and Settings → Keyboard, resolves them
  under the user's overrides and ThinkRail's own chords ([[submodule-web-keybindings]]), and delivers a
  matched command id to `GlobalOverlayProps.onCommand(listener)` (returns the unsubscribe) only while the
  extension is enabled. **`claimKeyboard(active)`** tells the host the overlay owns the keyboard: while a
  claim is held the host dispatches no app chord and no command, and the overlay handles every key itself,
  asking **`matchCommand(event)`** whether a key is one of its own commands under the effective bindings.
  An overlay's own key listener must act only while it holds the claim; that is what makes the host's and
  the overlay's listeners order-independent.
- `shortcuts` are display rows (`id`, `title` `MessageKey`, non-empty `keys` of `ExtensionShortcutKey` —
  the same fields as `ExtensionChord`) for keys the extension handles itself and the user cannot rebind
  (hint mode's in-mode keys); the cheatsheet lists them while the extension is enabled. `defineWebExtension` is a typed identity helper: it preserves the
  descriptor and its inferred keys without registration or default injection.
- `./server` exposes `ServerExtension`, `SdkToolServices`, `ToolResponse`, `InteractiveTool` and `defineServerExtension`.
  Descriptors hold `name`, optional display copy, `sdkTools`, `sdkChildTools`, `interactiveTools`, boolean `settings` and `skillPackages`.
  Factories return SDK tools from explicit host services.
  The helper preserves the descriptor without registration or default values.
  The host supplies cwd, grant checks, saved responses, failure reporting, workspace checks and frozen settings.
  The server entry also exports `parseToolResultContent` and `ParsedToolResultContent` for host result projection.
- `./server/typeBoxTool` exports `defineTypeBoxTool`. It uses the same TypeBox object for validation before
  SDK execute and the non-strict model schema.
  It keeps optional fields, additional properties and approval settings, and delegates malformed JSON to the SDK.
- The root is browser-safe and exposes only the web contract; it never re-exports the server half.
- Workspace dependencies are `contracts` and, type-only, `@thinkrail/locales/react`'s `Translator`.
  React remains type-only. The descriptor entry uses the SDK only for types.
  Only the opted-in tool entry imports the SDK and TypeBox at runtime and requires the SDK peer.
  The package has no React components, registry, DOM access or host imports.
- `ToolSummary` is `(props, t) => string`: the host passes the render-time `Translator` from `useT()`
  (`getToolSummary(t, name, props)`), so a collapsed card or routine row recomputes its summary on a
  language change; a summary translates only through that `t`, never the global translator
  (`check:i18n` flags a `summary` that reads it — [[module-locales]]).

Canonical tool-result parsing remains shared by renderer text extraction and the host's common image
layer: accept only well-formed supported image blocks, preserve text-block order, and fall back to
readable values for noncanonical results. Props-driven renderers receive optional file navigation from
the host, never acquire it from a store or transport. Extension composition rules live in
[[module-thinkrail-extensions]].

## Verification

Package tests exercise descriptors through their public entries, pure argument/result helpers and
browser bundling of both the root and `./web`. Browser bundles permit only contracts at runtime and
reject React, pi, host and server imports; `./server` separately verifies that SDK types do not enter runtime bundles.
The app's registry and common-image-layer tests retain coverage of the host-owned rendering behavior.

The SDK factory receives fresh `SdkToolServices`: run-grant validation, the saved owned response,
workspace path checks and frozen per-extension settings. The host uses
public SDK interruptions for interactive calls and recreates the factories before checkpoint restoration.
The SDK import is server-only and type-only in this contract package; browser entries stay SDK-free.

SDK tool factories use `errorFunction: null`; the host public invocation boundary owns failure projection with the original tool-call identity. `SdkToolServices` does not expose a parallel failure-marker callback. Stop and revoked grants propagate instead of becoming successful fallback text.

`WorkspaceFiles.createArtifact(name, content)` is a run-scoped host capability: it creates only an exclusive Markdown file below the current live workspace context/visualize directory, rechecking the run grant and workspace identity after asynchronous preparation. The host owns its destination; extension arguments cannot choose another cwd. `artifactsDir` names the workspace-relative artifacts root. Services remain outside checkpoint context.

An SDK extension may declare `artifactTools` to identify artifact paths shown or picked by its own successful tool results. The host resolves paths against the owning workspace before updating the artifact index.
