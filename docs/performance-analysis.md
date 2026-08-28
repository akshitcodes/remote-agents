# Remote Agents UI performance analysis

Measured on 2026-08-28 against the local Chrome UI and bridge, before the code-card presentation change in the same development session. Provider agent processes were excluded. Chrome uses a shared GPU process, so GPU-process measurements show direction and relative change, not exact per-tab GPU utilization.

## Current measurements

| Scenario | UI latency | Renderer CPU | Renderer memory |
| --- | ---: | ---: | ---: |
| Session list | Not separately timed | Near idle | About 62 MB |
| Open a running long thread | About 1.54 s | Peak about 52% of one core | About 101 MB |
| Load four older transcript batches | 444-473 ms per batch | Peak about 77% | About 132-169 MB during sampling |
| Completed thread after settling | Not applicable | About 2% | About 108 MB |
| Running thread with no meaningful text deltas | Not applicable | Sustained about 20-26% | Between roughly 160-280 MB depending on the macOS metric |

The expanded transcript contained 103 visible message blocks, 9,511 DOM nodes, 625 `pre`/`code` elements, and about 60,000 rendered text characters. This memory use is acceptable for the product today. The renderer CPU behavior during live work is the meaningful issue.

The bridge was comparatively light:

- Idle CPU was normally 0-0.2%.
- It peaked around 6-7% while serving transcript data.
- Ordinary RSS was roughly 48-73 MB.
- macOS reported a larger 379-394 MB footprint because it includes shared libraries, cached pages, and swapped pages. `vmmap` showed about 87 MB of dirty resident application memory.

## Confirmed hot paths

### 1. Full Markdown replacement on every assistant delta

`appendAgent()` appends the new text to the complete response, parses the entire accumulated response with Marked, sanitizes all resulting HTML with DOMPurify, and replaces the message DOM through `innerHTML`. The amount of work therefore grows with every delta, and the complete subtree is repeatedly laid out and painted.

This is the highest-impact CPU opportunity. The code-block presentation change intentionally does not add highlighting or header decoration to this live-delta path. Rich code rendering is applied only to history and finalized assistant messages.

### 2. Rebuilding reasoning and command-output text

Reasoning and command deltas use `textContent += delta`. This repeatedly reads and replaces the complete growing string and can also become quadratic for large outputs.

### 3. Scroll scheduling for every delta

Every assistant, reasoning, and command delta calls `scrollDown()`, but the current sequence guard already makes superseded animation-frame callbacks return before reading `scrollHeight`. This still allocates and queues callbacks during bursts, but current source evidence does not support treating it as a primary layout or compositor problem. Measure it alongside the Markdown work before changing it.

### 4. Running-state animation cost

A completed thread settled near 2% renderer CPU, while a running thread remained around 20-26% during a five-second window with no text-delta traffic. That view had three visible pulsing indicators and one gradient text shimmer. The gradient is clipped through text and changes background position continuously, which is more likely to repaint than an opacity- or transform-only animation.

Closing the isolated profiling tab terminated its renderer and reduced the shared Chrome GPU-process CPU from about 26% to about 11%. Other Chrome tabs were open, so this establishes meaningful page contribution but not an exact per-tab GPU percentage.

### 5. Transcript DOM grows linearly

Pagination keeps initial rendering bounded, which is good. Repeatedly loading older history still leaves every loaded node mounted. At 103 messages the DOM reached 9,511 nodes. This is not yet a memory blocker, but it will eventually affect style, layout, selection, and accessibility-tree work on very large histories.

## Recommended implementation order

### P1: Batch live Markdown rendering

Buffer assistant deltas and update rendered Markdown at most once every 50-100 ms. Always run one exact final render on `item/completed`.

Expected gain: the largest CPU reduction during streamed answers. A 50-100 ms visual cadence should remain perceptually live while collapsing many provider deltas into one parse, sanitize, DOM replacement, layout, and paint.

Trade-off: partially formed Markdown may visually settle in small steps rather than token by token. Final content remains exact.

### P1: Append plain output without rebuilding it

Use a persistent text node and `appendData()` for reasoning and command output. If events are extremely frequent, buffer these updates to one animation frame as well.

Expected gain: removes repeated whole-string allocation and DOM replacement for long tool output.

### P1: Replace repaint-heavy running animation

Replace the clipped gradient shimmer with a static working label or an opacity/transform-only indicator. Pause all decorative animations when the document is hidden, when the relevant element is offscreen, or when the thread is no longer running. Extend `prefers-reduced-motion` to every running and streaming indicator.

Expected gain: completed-like idle CPU while a turn is waiting on tools or the provider.

Trade-off: slightly less visual motion. Run state remains clear through color, label, and one inexpensive indicator.

### P2: Bound mounted transcript history

Keep a generous window of recent rendered items and replace much older mounted content with a measured-height placeholder. Restore it when the user scrolls or asks to load it.

Expected gain: predictable DOM and accessibility-tree size for very long sessions.

Trade-off: this is more complex than the other changes because scroll anchoring, search, copying, live reconciliation, and “Load earlier” must remain exact. Given current acceptable memory, it should follow the streaming fixes rather than precede them.

### P3: Avoid inactive list decoration

Create running-dot elements only for rows that are actually running rather than placing hidden animated descendants in every session row. This is a smaller DOM cleanup, not a primary CPU fix.

## Required verification for performance changes

Each optimization should be evaluated as part of the complete transcript lifecycle, not in isolation:

- Codex, Claude, and Grok streaming output.
- Fenced and unfinished Markdown while streaming, followed by exact final Markdown.
- Reasoning and large command output.
- Sticky following at the bottom and reading while scrolled upward.
- Reconnect and canonical refresh without duplicate assistant messages.
- Cached history, “Load earlier,” and long transcripts.
- Desktop and phone layouts.
- Renderer CPU, memory, DOM size, and render latency compared against the measurements above.

No performance optimization is included with this document. The code-card feature shipped alongside it adds syntax highlighting only after a message is final or loaded from history, never on each streaming delta, and skips inference/highlighting for blocks above 200,000 characters. Because the measurements predate that presentation change, the next optimization pass should re-baseline history rendering before using these numbers as its comparison point.

## Rich-document rendering guardrails

Markdown files reuse the already-loaded Marked and DOMPurify path, so they add no new library cost. Mermaid is deliberately absent from the app shell and ordinary message path: the vendored renderer is fetched and cached only after a completed/history message or opened Markdown file contains a `mermaid` fence, and each diagram is rendered only when it approaches the viewport. Rendering is serialized, source is capped at 50,000 characters, graph edges are capped at 500, and streaming deltas never trigger diagrams.

HTML files use a sandboxed `iframe` preview only when the user opens that file. The iframe has an opaque origin and a deny-by-default CSP; scripts, forms, popups, same-origin access, and network requests are unavailable. Source remains accessible and is the default for files above 750,000 characters. This avoids putting untrusted project HTML into the app DOM and bounds expensive parsing for unusually large files.
