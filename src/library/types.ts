/**
 * Library module types — virtual folders, state tracking, and tree structures.
 */

export interface LibraryFolder {
  id: string;              // folder_<timestamp>_<8hex>
  name: string;
  parentId: string | null; // null = root level
  path: string;            // materialized: "/Documents/Reports"
  icon: string;            // emoji or icon name
  color: string | null;
  sortOrder: number;
  isSystem: boolean;       // true for default root folders (cannot be deleted)
  systemType?: string;     // virtual folder type: "last-used" — drives special UI/API behavior
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface LibraryStateEntry {
  id: string;              // ls_<timestamp>_<8hex>
  type: "recent" | "favorite";
  targetType: "file" | "folder";
  targetId: string;
  timestamp: string;
  status: "active" | "removed";
}

export interface FolderTreeNode {
  folder: LibraryFolder;
  children: FolderTreeNode[];
  fileCount: number;
}

export const DEFAULT_ROOT_FOLDERS = [
  { name: "Documents",  icon: "file-text", sortOrder: 1 },
  { name: "Images",     icon: "image",     sortOrder: 2 },
  { name: "Media",      icon: "film",      sortOrder: 3 },
  { name: "Templates",  icon: "copy",      sortOrder: 4 },
  { name: "Reports",    icon: "bar-chart", sortOrder: 5 },
  { name: "Inbox",      icon: "inbox",     sortOrder: 6 },
] as const;
