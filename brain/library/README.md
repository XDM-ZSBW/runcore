# Library Module

Virtual folder navigation over Core's flat file registry. Inspired by SharePoint/OneDrive — familiar tree + search + recents experience.

## Architecture

- **Folders are metadata-only.** No files are physically moved. A folder is a JSONL record with `name`, `parentId`, `path`.
- **Files link via `meta.folderId`.** Each `FileEntry.meta.folderId` points to a `LibraryFolder.id`. The folder assignment travels with the file everywhere.
- **Default root folders** are seeded on first load: Documents, Images, Media, Templates, Reports, Inbox.

## Data files

| File | Content |
|------|---------|
| `folders.jsonl` | Virtual folder hierarchy. Append-only, last-id-wins. |
| `state.jsonl` | Recents + favorites tracking. Append-only. |

## Key behaviors

- **Tree navigation**: Recursive folder tree with expand/collapse and file counts per folder.
- **Breadcrumbs**: Materialized path (`/Documents/Reports`) computed from parentId chains.
- **Recents**: Last 20 accessed files/folders, updated on view.
- **Favorites**: Pinned items, toggle on/off.
- **Search**: Unified search across files (name, tags, content) and folders (name).
- **Unfiled files**: Files without `meta.folderId` — the Inbox equivalent.

## UI

`/library` serves a three-panel file explorer: sidebar (tree + favorites + recents), main content (grid/list of folder contents), detail panel (metadata + actions on click).
