---
id: submodule-server-images
type: submodule-design
status: active
title: images — image bytes off the WebSocket
parent: module-server
depends-on: [module-contracts]
tags: [public-surface-checked]
---

## Responsibility

Project canonical image blocks from host-owned session display data into `RefImage` values and serve
the bytes over `GET /images/<sessionId>/<sha>`. The SDK owner retains original bytes in canonical
transcript, model history, queue inputs and RunState. This module never reads disk or attaches sessions.

## Boundary

- `projectImages(value, sessionId)` recursively replaces nonempty `{type:"image",data,mimeType}` blocks
  with `{type:"image",mimeType,ref,width?,height?}`. Unchanged subtrees retain identity; callers that
  return snapshots or publish events clone the projected result to keep their existing isolation.
- References hash MIME type, a NUL separator and base64 data. Per-object hash/dimension memoization
  rechecks both data and MIME type before reuse. Header dimensions are sniffed from at most 256 KiB.
- Every projected block registers its original string in a bounded 256 MiB LRU cache. The cache holds
  references, is never a persistence owner and is reset when the host stops. `cacheLimitChars` exists
  only for tests. `forgetImageSession` retires a deleted chat's entries.
- The injected `ImageSource` confirms liveness on every fetch, including cache hits, and finds misses
  only in current attached canonical message content. It cannot load a record from disk. Closing or
  deleting a session or closing its workspace makes it unservable. A missing/deleting workspace or closed/missing owning
  project also refuses service; the Chats container remains an allowed owning project. Direct hidden-child URLs are refused.
- Child transcript reads validate ownership and attach the parent through the existing SDK owner;
  their blocks register under the parent chat ID. A child image evicted from the cache recovers after
  the next successful transcript poll/reopen registers it again.
- `serveImage` accepts exactly a bounded session segment and 64-hex hash, with query strings handled
  by the host route. It serves only PNG/JPEG/GIF/WebP, returning no-store/nosniff and a sandbox CSP.
  A miss is a no-store 404. The host permits GET/HEAD and rejects other methods with 405.
- The route follows the host's existing unauthenticated files/blob HTTP policy and adds no CORS
  allowance. A hash identifies content; it does not grant access to an unattached or retired session.

The browser retries a failed image after successful transcript resynchronization; raw reconnect alone
cannot establish registration. Explicit Retry cache-busts the URL. Already decoded page images may
remain visible after their chat is retired; future requests are refused.

Only canonical image blocks are projected. Explicit full-output raw text RPCs retain their existing
semantics; arbitrary business text and data URLs are not recursively parsed. The known structured SDK
tool-result display envelope is normalized before projection, without changing SDK output/history.
Client uploads and composer restoration (queue clear/removal, abort restoration and creation dismissal)
keep inline bytes because the composer must resend them. Current production model/read capabilities
are unchanged; this feature does not enable vision.

- **Public surface (barrel):** `projectImages`, `imageDimensions`, `Dimensions`, `setImageSource`,
  `ImageSource`, `ImageBlock`, `findImageBlock`, `forgetImageSession`, `resetImages`, `serveImage`.
- **Allowed deps:** contracts (`IMAGES_ROUTE`, `ACCEPTED_IMAGE_TYPES`, `RefImage`) and Node crypto.
- **Forbidden:** host, agent, other feature modules, persistent storage and disk reads. The agent imports
  this module; the host injects its live source.
