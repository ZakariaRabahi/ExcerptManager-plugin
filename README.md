# ExcerptManager

An Obsidian plugin for structured PDF-based literature review.

Select text or image regions from PDFs, save them as typed *excerpts*, organise them under research *claims*, visualise the network as an interactive graph, and optionally sync everything to an RSL server.

## Features

- **PDF capture** — select text or Alt-drag an image region in any open PDF to create an excerpt note with page number, bounding rectangles, and selection range stored automatically.
- **Claims** — articulate research assertions and link excerpts to them with typed relations (`supports`, `contradicts`, `refines`, `related-to`, or custom).
- **Graph** — interactive SVG graph with column layout (Paper → Excerpt → Claim) and orbit layout; provenance edges, spacing slider, relation-type filters, drag-to-pin positions.
- **Compare** — pin excerpts side-by-side for cross-source comparison.
- **Export** — copy any claim and all its linked excerpts as formatted markdown (H2 heading, blockquote excerpts with citations).
- **RSL sync** — push/pull papers, excerpts, claims, and relations to an external RSL REST server.

All data is stored as plain markdown files with YAML frontmatter inside your vault — human-readable and version-controllable.
