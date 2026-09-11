# Website documentation

The `/docs` section is an end-user manual, separate from the marketing pages. It contains 15 guides: introduction, installation, quick start, projects/layouts, terminals/agents, shared providers, Open Codex, Codex Web, Fusion, Open Fusion, Orchestrator, voice, history/setups, controls, and troubleshooting.

## Layout and navigation

The documentation uses a grouped, searchable left sidebar, a readable article column, and a sticky right-hand section outline. Breadcrumbs, section permalinks, current-section highlighting, previous/next links, read-time estimates, contextual screenshots, numbered steps, callouts, reference tables, and copyable code examples support the guides.

On smaller screens, the guide menu collapses and the section outline moves into an expandable block above the article. Ctrl/Cmd+K focuses search. Enter opens the first search result; Escape clears search or closes the mobile menu. Search matches titles, section headings, and body content and links directly to the relevant section. Invalid guide paths have an explicit missing-guide view. Print styles remove navigation.

The docs are loaded as a separate Vite chunk, so the full manual is not included in the initial marketing bundle. Documentation reads do not request GitHub release metadata. Deep links are scrolled into view after the lazy-loaded article mounts.

## Content and maintenance

- `frontend/src/docs/content.ts`: typed guide content, groups, text indexing, and search.
- `frontend/src/docs/DocsPage.tsx`: sidebar, article/block renderer, search, copy actions, outline, and navigation.
- `frontend/src/docs/docs.css`: documentation-only layout and reading styles.
- `backend/src/app.ts`: serves `/docs` and nested documentation paths through the existing app.

Content is grounded in the sibling app README, current provider and terminal controls, Fusion/Open Fusion guides, Orchestrator, voice, and Windows release docs. In particular, the current shared provider location is Models & providers, and Codex Web's current login flow requires ChatGPT Web sign-in without an additional native Codex login. Availability and local/cloud distinctions are described without claiming live feature acceptance or introducing plan enforcement.

Update the guide content alongside control or feature changes. Screenshots are illustrative app captures from the website's existing assets, and can lag behind newer controls. No third-party markdown renderer or documentation framework was added.

## Verification

Production builds passed for both workspaces. Tests cover all 15 docs routes, search relevance, empty/no-result queries, unique slugs and section IDs, guide groups, internal guide links, anchor targets, referenced screenshots, and the pre-existing API/download checks. The introductory guide opened in the user's browser. These checks are not a complete browser/device interaction matrix.
