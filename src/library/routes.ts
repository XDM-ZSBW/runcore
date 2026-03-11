/**
 * Library API routes — mounted at /api/library in server.ts.
 * Virtual folder navigation + file browsing over the flat FileManager registry.
 */

import { Hono } from "hono";
import { createLogger } from "../utils/logger.js";
import { FileManager } from "../files/manager.js";
import { getLibraryStore } from "./store.js";
import type { FileCategory } from "../files/types.js";
import { badRequest, unauthorized, forbidden, notFound } from "../middleware/error-handler.js";

const log = createLogger("library.routes");

export const libraryRoutes = new Hono();

/** Get store or 503. */
function store() {
  const s = getLibraryStore();
  if (!s) throw new Error("Library not initialized");
  return s;
}

/** Get FileManager or 503. */
function fm() {
  const f = FileManager.getInstance();
  if (!f) throw new Error("FileManager not initialized");
  return f;
}

// ── Folder tree ────────────────────────────────────────────────────────────

libraryRoutes.get("/tree", async (c) => {
  try {
    const lib = store();
    const fileMgr = fm();

    // Count files per folderId
    const allFiles = await fileMgr.list();
    const fileCounts = new Map<string, number>();
    for (const f of allFiles) {
      const fid = f.meta?.folderId as string | undefined;
      if (fid) fileCounts.set(fid, (fileCounts.get(fid) ?? 0) + 1);
    }

    const tree = await lib.getTree(fileCounts);
    const unfiled = allFiles.filter((f) => !f.meta?.folderId).length;
    return c.json({ tree, unfiled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Folder contents ────────────────────────────────────────────────────────

libraryRoutes.get("/folders/:id", async (c) => {
  try {
    const lib = store();
    const fileMgr = fm();
    const id = c.req.param("id");

    const folder = await lib.getFolder(id);
    if (!folder) notFound("Folder not found");

    const subfolders = await lib.listFolders(id);
    const breadcrumb = await lib.getBreadcrumb(id);

    // System folder: "last-used" pulls from recents instead of folderId
    let files;
    if (folder.systemType === "last-used") {
      const recents = await lib.getRecents(60);
      const hydrated = [];
      const seen = new Set<string>();
      for (const r of recents) {
        if (r.targetType !== "file") continue;
        if (seen.has(r.targetId)) continue;
        seen.add(r.targetId);
        const file = await fileMgr.get(r.targetId);
        if (file && file.status !== "archived") {
          hydrated.push({ ...file, _lastAccessed: r.timestamp });
        }
        if (hydrated.length >= 30) break;
      }
      files = hydrated;
    } else {
      files = await fileMgr.list({ folderId: id });
    }

    // Record access
    await lib.recordAccess(id, "folder");

    return c.json({ folder, subfolders, files, breadcrumb });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Create folder ──────────────────────────────────────────────────────────

libraryRoutes.post("/folders", async (c) => {
  try {
    const lib = store();
    const body = await c.req.json();

    if (!body.name) badRequest("name required");

    const folder = await lib.createFolder({
      name: body.name,
      parentId: body.parentId ?? null,
      icon: body.icon,
      color: body.color,
    });
    return c.json(folder, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Update folder ──────────────────────────────────────────────────────────

libraryRoutes.patch("/folders/:id", async (c) => {
  try {
    const lib = store();
    const id = c.req.param("id");
    const body = await c.req.json();

    const updated = await lib.updateFolder(id, body);
    if (!updated) notFound("Folder not found or not modifiable");
    return c.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Archive folder ─────────────────────────────────────────────────────────

libraryRoutes.delete("/folders/:id", async (c) => {
  try {
    const lib = store();
    const id = c.req.param("id");
    const result = await lib.archiveFolder(id);
    return c.json(result, result.ok ? 200 : 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── List files ─────────────────────────────────────────────────────────────

libraryRoutes.get("/files", async (c) => {
  try {
    const fileMgr = fm();
    const folderId = c.req.query("folderId");
    const category = c.req.query("category") as FileCategory | undefined;
    const search = c.req.query("search");
    const unfiled = c.req.query("unfiled");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    if (unfiled === "true") {
      // All files without a folderId
      const all = await fileMgr.list({ category, search, limit: 1000 });
      let results = all.filter((f) => !f.meta?.folderId);
      const total = results.length;
      results = results.slice(offset, offset + limit);
      return c.json({ files: results, total });
    }

    const files = await fileMgr.list({ folderId: folderId ?? undefined, category, search, limit, offset });
    return c.json({ files, total: files.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Upload file ────────────────────────────────────────────────────────────

libraryRoutes.post("/files/upload", async (c) => {
  try {
    const fileMgr = fm();
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) badRequest("No file provided");

    const buffer = Buffer.from(await file.arrayBuffer());
    const folderId = formData.get("folderId") as string | null;
    const category = (formData.get("category") as FileCategory) || "upload";
    const tags = formData.get("tags") as string | null;

    const result = await fileMgr.upload({
      buffer,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      category,
      tags: tags ? tags.split(",").map((t) => t.trim()) : [],
      origin: "user-upload",
    });

    if (!result.ok || !result.file) {
      badRequest(result.message);
    }

    // Assign to folder via meta
    if (folderId) {
      await fileMgr.updateMetadata(result.file.id, {
        meta: { folderId },
      });
      // Re-fetch to get updated entry
      const updated = await fileMgr.get(result.file.id);
      if (updated) result.file = updated;
    }

    return c.json({ file: result.file }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── File metadata ──────────────────────────────────────────────────────────

libraryRoutes.get("/files/:id", async (c) => {
  try {
    const fileMgr = fm();
    const lib = store();
    const id = c.req.param("id");

    const file = await fileMgr.get(id);
    if (!file) notFound("File not found");

    // Record access
    await lib.recordAccess(id, "file");

    // Check favorite status
    const favorited = await lib.isFavorite(id);

    return c.json({ file, favorited });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── File text content (for feed/preview rendering) ────────────────────────

libraryRoutes.get("/files/:id/content", async (c) => {
  try {
    const fileMgr = fm();
    const id = c.req.param("id");
    const maxChars = parseInt(c.req.query("max") ?? "10000", 10);

    const result = await fileMgr.read(id);
    if (!result.ok || !result.data || !result.entry) {
      notFound(result.message);
    }

    const textMimes = [
      "text/markdown", "text/plain", "text/yaml", "text/csv",
      "application/json", "application/x-yaml",
    ];
    const isText = textMimes.some((m) => result.entry!.mimeType.includes(m))
      || result.entry!.name.match(/\.(md|txt|yaml|yml|json|csv|log)$/i);

    if (!isText) {
      return c.json({ id, content: null, reason: "binary" });
    }

    const full = result.data.toString("utf-8");
    const content = full.slice(0, maxChars);
    const truncated = full.length > maxChars;

    return c.json({ id, content, truncated, totalChars: full.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Download file ──────────────────────────────────────────────────────────

libraryRoutes.get("/files/:id/download", async (c) => {
  try {
    const fileMgr = fm();
    const id = c.req.param("id");

    const result = await fileMgr.read(id);
    if (!result.ok || !result.data || !result.entry) {
      notFound(result.message);
    }

    return new Response(result.data, {
      headers: {
        "Content-Type": result.entry.mimeType,
        "Content-Disposition": `attachment; filename="${result.entry.name}"`,
        "Content-Length": result.data.length.toString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Update file metadata ───────────────────────────────────────────────────

libraryRoutes.patch("/files/:id", async (c) => {
  try {
    const fileMgr = fm();
    const id = c.req.param("id");
    const body = await c.req.json();

    const patch: Record<string, any> = {};
    if (body.name) patch.name = body.name;
    if (body.tags) patch.tags = body.tags;
    if (body.category) patch.category = body.category;
    if (body.folderId !== undefined) {
      patch.meta = { folderId: body.folderId };
    }

    const result = await fileMgr.updateMetadata(id, patch);
    if (!result.ok) notFound(result.message);
    return c.json({ file: result.file });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Archive file ───────────────────────────────────────────────────────────

libraryRoutes.delete("/files/:id", async (c) => {
  try {
    const fileMgr = fm();
    const id = c.req.param("id");
    const result = await fileMgr.archive(id, "user");
    return c.json(result, result.ok ? 200 : 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Search ─────────────────────────────────────────────────────────────────

libraryRoutes.get("/search", async (c) => {
  try {
    const fileMgr = fm();
    const lib = store();
    const q = c.req.query("q") ?? "";
    const category = c.req.query("category") as FileCategory | undefined;
    const folderId = c.req.query("folderId");

    if (!q) return c.json({ files: [], folders: [] });

    // Search files
    const files = await fileMgr.list({
      search: q,
      category,
      folderId: folderId ?? undefined,
      limit: 50,
    });

    // Search folders by name
    const allFolders = await lib.listFolders();
    const qLower = q.toLowerCase();
    const folders = allFolders.filter((f) =>
      f.name.toLowerCase().includes(qLower) || f.path.toLowerCase().includes(qLower),
    );

    return c.json({ files, folders });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Last Used (virtual folder) ────────────────────────────────────────────

libraryRoutes.get("/last-used", async (c) => {
  try {
    const lib = store();
    const fileMgr = fm();
    const limit = parseInt(c.req.query("limit") ?? "30", 10);
    const recents = await lib.getRecents(limit * 2); // over-fetch to handle missing files

    // Hydrate file entries, skip folders and missing files
    const files = [];
    const seen = new Set<string>();
    for (const r of recents) {
      if (r.targetType !== "file") continue;
      if (seen.has(r.targetId)) continue;
      seen.add(r.targetId);

      const file = await fileMgr.get(r.targetId);
      if (file && file.status !== "archived") {
        files.push({ ...file, _lastAccessed: r.timestamp });
      }
      if (files.length >= limit) break;
    }

    return c.json({ files, total: files.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Recents ────────────────────────────────────────────────────────────────

libraryRoutes.get("/recents", async (c) => {
  try {
    const lib = store();
    const files = fm();
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const recents = await lib.getRecents(limit);

    // Resolve names so the UI doesn't have to show raw IDs
    const enriched = await Promise.all(recents.map(async (r) => {
      let name: string | null = null;
      if (r.targetType === "folder") {
        const folder = await lib.getFolder(r.targetId);
        name = folder?.name ?? null;
      } else {
        const file = await files.get(r.targetId);
        name = file?.name ?? null;
      }
      return { ...r, name };
    }));

    // Filter out entries whose target no longer exists
    return c.json({ recents: enriched.filter((r) => r.name !== null) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Favorites ──────────────────────────────────────────────────────────────

libraryRoutes.get("/favorites", async (c) => {
  try {
    const lib = store();
    const favorites = await lib.getFavorites();
    return c.json({ favorites });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

libraryRoutes.post("/favorites/:id", async (c) => {
  try {
    const lib = store();
    const id = c.req.param("id");
    const body = await c.req.json();
    const targetType = body.type === "folder" ? "folder" : "file";
    const result = await lib.toggleFavorite(id, targetType as "file" | "folder");
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ── Stats ──────────────────────────────────────────────────────────────────

libraryRoutes.get("/stats", async (c) => {
  try {
    const fileMgr = fm();
    const lib = store();

    const usage = await fileMgr.getStats();
    const allFiles = await fileMgr.list({ limit: 10000 });

    // Files per folder
    const byFolder = new Map<string, { count: number; bytes: number }>();
    let unfiledCount = 0;
    let unfiledBytes = 0;
    for (const f of allFiles) {
      const fid = f.meta?.folderId as string | undefined;
      if (fid) {
        const current = byFolder.get(fid) ?? { count: 0, bytes: 0 };
        current.count++;
        current.bytes += f.sizeBytes;
        byFolder.set(fid, current);
      } else {
        unfiledCount++;
        unfiledBytes += f.sizeBytes;
      }
    }

    // Resolve folder names
    const folderStats: Array<{ folderId: string; name: string; count: number; bytes: number }> = [];
    for (const [fid, stats] of byFolder) {
      const folder = await lib.getFolder(fid);
      folderStats.push({
        folderId: fid,
        name: folder?.name ?? "Unknown",
        ...stats,
      });
    }

    return c.json({
      total: usage,
      byFolder: folderStats,
      unfiled: { count: unfiledCount, bytes: unfiledBytes },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});
