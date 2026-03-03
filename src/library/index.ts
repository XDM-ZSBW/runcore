/**
 * Library module — virtual folder navigation over the file registry.
 */

export type { LibraryFolder, LibraryStateEntry, FolderTreeNode } from "./types.js";
export { DEFAULT_ROOT_FOLDERS } from "./types.js";
export { LibraryStore, createLibraryStore, getLibraryStore } from "./store.js";
