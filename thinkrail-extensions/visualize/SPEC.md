---
id: module-ext-visualize
type: module-design
status: active
title: SDK visualization extension
parent: module-thinkrail-extensions
depends-on: [module-ui, module-extension-api, module-visualize, module-locales]
references: [submodule-web-chat, submodule-server-extensions]
---

## Responsibility

The server creates the SDK `visualize` tool.
The web entry renders diagrams, option comparisons and file previews by the same tool name.
Pure schemas and result helpers come from `@thinkrail/visualize`.

## Boundaries

The server descriptor exposes `sdkTools` without child tools or Skill packages.
It uses the supplied run-grant check and workspace file checks.
Arguments pass TypeBox and shape validation before Mermaid parsing or preview access.
Each failure identifies the relevant field and asks for a correction.
A post-validation grant check prevents a late successful result after Stop.
The result retains validated parameters in details and readable Markdown in content.

The server uses the catalog-pinned Mermaid parser and linkedom.
The browser uses that same Mermaid version with lazy rendering and a defensive fallback.
It renders at natural size by disabling `useMaxWidth` on diagram kinds in Mermaid's pinned default
configuration; CSS caps the SVG to its available width. Strict security, theme handling and render
limits remain in force.
Syntax parsing does not prove SVG layout success.

## Mermaid state

Lazy parser initialization installs a temporary DOM.
It restores the previous window and document descriptors in a finally block.
Parser calls use a shared promise tail because Mermaid changes shared configuration.
Tests cover strict syntax rejection, required DOM behavior, global restoration and cross-instance serialization.

## Web entry

The web descriptor exports its tool renderers and the shared `MermaidView` component.
Its primary renderer starts expanded and opts into `width: "content"`, so diagrams and comparisons
can grow beyond the prose column within the chat pane. File previews have no intrinsic width and
keep their fixed frame in the column.
It uses public extension, UI, resource-renderer and locale interfaces.
It does not import server code or SDK execution.
The server and web halves share only the tool name and pure argument shape.

Successful diagram and comparison calls save the validated Markdown through the run-scoped WorkspaceFiles.createArtifact capability, under context/visualize with a timestamp/slug and exclusive collision suffixes. The host rechecks grant and workspace identity after asynchronous preparation; Stop cannot authorize later writes. Saving is best effort: I/O failure preserves the valid preview without claiming a saved path, while the final active-run check still rejects a stopped run. Saved-to text names the actual created relative path and original renderer details remain unchanged. File previews continue reading existing files and do not save a duplicate.
