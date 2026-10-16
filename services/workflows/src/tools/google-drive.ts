import { connectorSignInPath } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const DRIVE_SIGN_IN = connectorSignInPath('google-drive');

const ACTIONS = [
  'drive_search',
  'drive_list',
  'drive_get_text',
  'drive_upload',
  'drive_share',
  'drive_create_folder',
] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('share') || a.includes('permission')) return 'publish';
  if (a.includes('upload') || a.includes('create_file') || a.includes('create_folder')) return 'draft';
  return 'read';
}

async function googleToken(orgId: string, action: string, timestamp: string) {
  const auth = await resolveGoogleAuth(orgId, 'google-drive');
  if (auth.kind !== 'connected') {
    return { token: null, authErr: nangoAuthError('google-drive', action, timestamp, auth) };
  }
  return { token: auth.accessToken as string, authErr: null };
}

/**
 * Extracts a folder or file ID from a raw string or Google Drive URL.
 */
export function extractDriveId(raw: unknown): { id: string | null; isUrl: boolean } {
  if (typeof raw !== 'string') return { id: null, isUrl: false };
  const str = raw.trim();
  if (!str) return { id: null, isUrl: false };
  if (str === 'root' || str === '/') return { id: 'root', isUrl: false };

  // Patterns:
  // https://drive.google.com/drive/folders/1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi
  // https://drive.google.com/drive/u/0/folders/1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi?usp=sharing
  const folderMatch = str.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch && folderMatch[1]) return { id: folderMatch[1], isUrl: true };

  // https://drive.google.com/file/d/1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi/view
  const fileMatch = str.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]+)/);
  if (fileMatch && fileMatch[1]) return { id: fileMatch[1], isUrl: true };

  // https://colab.research.google.com/drive/1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi
  const colabMatch = str.match(/colab\.research\.google\.com\/drive\/([a-zA-Z0-9_-]+)/);
  if (colabMatch && colabMatch[1]) return { id: colabMatch[1], isUrl: true };

  // Query parameter ?id=...
  const idParamMatch = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch && idParamMatch[1]) return { id: idParamMatch[1], isUrl: true };

  // Standard Google Drive ID: length >= 16 without spaces or quotes
  if (/^[a-zA-Z0-9_-]{16,}$/.test(str)) {
    return { id: str, isUrl: false };
  }

  return { id: null, isUrl: false };
}

export class GoogleDriveHttpError extends Error {
  constructor(readonly status: number, readonly details: string = '') {
    super(`Google Drive HTTP ${status}`);
    this.name = 'GoogleDriveHttpError';
  }
}

/** 401/403 are a revoked connector or missing scope. Any other non-2xx is an API error, never an empty list or success. */
export function googleDriveHttpFailure(
  action: string,
  timestamp: string,
  status: number,
  details: string = ''
) {
  const isRevoked = status === 401 || status === 403;
  const isInsufficientScope =
    status === 403 && (details.includes('insufficient') || details.includes('SCOPE'));

  if (isInsufficientScope) {
    return {
      tool: 'google-drive',
      action,
      status: 'error' as const,
      message: `Google Drive connection requires the "drive" scope. Re-authorize Google Drive at ${DRIVE_SIGN_IN} with full Drive permissions.`,
      data: { connected: false, reason: 'insufficient_scope', setupUrl: DRIVE_SIGN_IN },
      timestamp,
    };
  }

  return {
    tool: 'google-drive',
    action,
    status: 'error' as const,
    message: isRevoked
      ? 'Google Drive connection was rejected (revoked or forbidden).'
      : `Google Drive request failed (HTTP ${status}).`,
    data: {
      reason: isRevoked ? 'revoked' : 'api_error',
      status,
      connected: !isRevoked,
      ...(isRevoked ? { setupUrl: DRIVE_SIGN_IN } : {}),
    },
    timestamp,
  };
}

/**
 * Searches for a folder by name in Google Drive.
 */
async function findFolderByName(
  gToken: string,
  name: string,
  parentFolderId?: string
): Promise<{ id: string; name: string; webViewLink?: string } | null> {
  const cleanName = name.replace(/'/g, "\\'");
  let parentClause = parentFolderId && parentFolderId !== 'root' ? `'${parentFolderId}' in parents and ` : '';

  // 1. Exact name match
  let q = `${parentClause}mimeType = 'application/vnd.google-apps.folder' and name = '${cleanName}' and trashed = false`;
  let res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${gToken}` } }
  );
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    throw new GoogleDriveHttpError(res.status, await res.text().catch(() => ''));
  }
  if (res.ok) {
    const data = (await res.json()) as { files?: Array<{ id: string; name: string; webViewLink?: string }> };
    if (data.files && data.files.length > 0) return data.files[0];
  }

  // 2. Partial / case-insensitive contains match
  q = `${parentClause}mimeType = 'application/vnd.google-apps.folder' and name contains '${cleanName}' and trashed = false`;
  res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${gToken}` } }
  );
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    throw new GoogleDriveHttpError(res.status, await res.text().catch(() => ''));
  }
  if (res.ok) {
    const data = (await res.json()) as { files?: Array<{ id: string; name: string; webViewLink?: string }> };
    if (data.files && data.files.length > 0) return data.files[0];
  }

  return null;
}

/**
 * Retrieves metadata for a folder.
 */
async function getFolderMeta(
  gToken: string,
  folderId: string
): Promise<{ id: string; name: string; webViewLink?: string } | null> {
  if (folderId === 'root') {
    return {
      id: 'root',
      name: 'My Drive (Root)',
      webViewLink: 'https://drive.google.com/drive/my-drive',
    };
  }
  try {
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${gToken}` } }
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new GoogleDriveHttpError(res.status, await res.text().catch(() => ''));
      }
      return null;
    }
    return (await res.json()) as { id: string; name: string; webViewLink?: string };
  } catch (err) {
    if (err instanceof GoogleDriveHttpError) throw err;
    return null;
  }
}

/**
 * Resolves any folder identifier (raw ID, URL, or name) into a verified folder ID and metadata.
 */
async function resolveFolder(
  gToken: string,
  rawInput?: unknown,
  fallbackParent?: string
): Promise<{ id: string; name: string; webViewLink?: string; error?: string }> {
  if (!rawInput || rawInput === 'root' || rawInput === '/') {
    return {
      id: 'root',
      name: 'My Drive (Root)',
      webViewLink: 'https://drive.google.com/drive/my-drive',
    };
  }

  const { id: extractedId } = extractDriveId(rawInput);
  if (extractedId) {
    const meta = await getFolderMeta(gToken, extractedId);
    if (meta) return meta;
    // Even if getFolderMeta 404s (e.g. shared drive root without read metadata), use extracted ID
    return {
      id: extractedId,
      name: `Folder (${extractedId.slice(0, 8)}...)`,
      webViewLink: `https://drive.google.com/drive/folders/${extractedId}`,
    };
  }

  // Treat as folder name and look up
  const nameStr = String(rawInput).trim();
  const found = await findFolderByName(gToken, nameStr, fallbackParent);
  if (found) return found;

  return {
    id: '',
    name: nameStr,
    error: `Folder "${nameStr}" could not be found in Google Drive. Please verify the folder name or provide its direct Google Drive link/ID.`,
  };
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const { token: gToken, authErr: gAuthErr } = await googleToken(orgId, actionName, timestamp);
  if (!gToken) return gAuthErr ?? notConnected('google-drive', actionName, timestamp);

  try {
    // ── 1. DRIVE SEARCH / FIND ────────────────────────────────────────────────
    if (actionName.includes('search') || actionName.includes('find')) {
      const rawQuery =
        payload.query || payload.q || payload.name || payload.search || payload.keyword || '';
      const typeFilter = String(payload.type || '').toLowerCase();
      const isColabSearch =
        typeFilter === 'colab' ||
        typeFilter === 'notebook' ||
        rawQuery.toLowerCase().includes('colab') ||
        rawQuery.toLowerCase().includes('notebook') ||
        rawQuery.toLowerCase().includes('.ipynb');
      const isFolderSearch =
        typeFilter === 'folder' ||
        typeFilter === 'folders' ||
        Boolean(payload.foldersOnly);

      const clauses: string[] = ['trashed = false'];

      if (rawQuery && !isColabSearch) {
        clauses.push(`name contains '${rawQuery.replace(/'/g, "\\'")}'`);
      }

      if (isFolderSearch) {
        clauses.push("mimeType = 'application/vnd.google-apps.folder'");
      } else if (isColabSearch) {
        clauses.push(
          "(mimeType = 'application/vnd.google.colaboratory' or name contains '.ipynb' or name contains 'colab')"
        );
      } else if (typeFilter === 'doc' || typeFilter === 'document') {
        clauses.push("mimeType = 'application/vnd.google-apps.document'");
      } else if (typeFilter === 'sheet' || typeFilter === 'spreadsheet') {
        clauses.push("mimeType = 'application/vnd.google-apps.spreadsheet'");
      } else if (typeFilter === 'slide' || typeFilter === 'presentation') {
        clauses.push("mimeType = 'application/vnd.google-apps.presentation'");
      }

      // Check if scoped inside a folder
      const rawFolderScope = payload.folderId || payload.folder || payload.parentId;
      if (rawFolderScope) {
        const resolvedScope = await resolveFolder(gToken, rawFolderScope);
        if (resolvedScope.id) {
          clauses.push(`'${resolvedScope.id}' in parents`);
        }
      }

      const qClause = clauses.join(' and ');
      const pageSize = payload.maxResults || 50;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        qClause
      )}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink,parents)&pageSize=${pageSize}&orderBy=${encodeURIComponent(
        'folder,modifiedTime desc'
      )}&supportsAllDrives=true&includeItemsFromAllDrives=true`;

      const driveRes = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${gToken}` } });

      if (!driveRes.ok) {
        const errText = await driveRes.text().catch(() => '');
        return googleDriveHttpFailure('drive_search', timestamp, driveRes.status, errText);
      }

      const driveData = (await driveRes.json()) as { files?: any[] };
      const allItems = driveData.files || [];
      const folders = allItems.filter(
        (f) => f.mimeType === 'application/vnd.google-apps.folder'
      );
      const files = allItems.filter(
        (f) => f.mimeType !== 'application/vnd.google-apps.folder'
      );

      return {
        tool: 'google-drive',
        action: 'drive_search',
        status: 'executed' as const,
        message: `Found ${folders.length} folder${folders.length === 1 ? '' : 's'} and ${files.length} file${files.length === 1 ? '' : 's'} matching search in Google Drive`,
        data: {
          query: rawQuery,
          typeFilter: typeFilter || (isColabSearch ? 'colab' : 'all'),
          totalFolders: folders.length,
          totalFiles: files.length,
          folders,
          files,
          allItems,
        },
        timestamp,
      };
    }

    // ── 2. DRIVE LIST (FOLDER CONTENTS OR ALL FOLDERS) ────────────────────────
    if (actionName.includes('list')) {
      const rawFolder =
        payload.folderId ??
        payload.folder_id ??
        payload.folder ??
        payload.parentId ??
        payload.parent_id ??
        payload.folderName ??
        payload.folder_name ??
        payload.folderUrl ??
        payload.folder_url ??
        payload.url ??
        payload.path ??
        (actionName.includes('folder') ? payload.name : undefined) ??
        'root';

      const isFoldersOnly =
        payload.foldersOnly ||
        payload.onlyFolders ||
        payload.type === 'folder' ||
        payload.type === 'folders' ||
        actionName.includes('list_folder');

      // Resolve folder target
      const resolved = await resolveFolder(gToken, rawFolder);
      if (resolved.error) {
        return {
          tool: 'google-drive',
          action: 'drive_list',
          status: 'error' as const,
          message: resolved.error,
          data: { rawInput: rawFolder },
          timestamp,
        };
      }

      const folderId = resolved.id;
      const folderName = resolved.name;

      let qClause: string;
      if (isFoldersOnly) {
        // Specifically listing folders
        if (folderId === 'root' && !payload.folderId) {
          // List all folders in the drive
          qClause = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
        } else {
          qClause = `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        }
      } else {
        // List everything under this folder
        qClause = `'${folderId}' in parents and trashed = false`;
      }

      const pageSize = payload.maxResults || 100;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        qClause
      )}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink,parents)&pageSize=${pageSize}&orderBy=${encodeURIComponent(
        'folder,modifiedTime desc'
      )}&supportsAllDrives=true&includeItemsFromAllDrives=true`;

      const driveRes = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${gToken}` } });

      if (!driveRes.ok) {
        const errText = await driveRes.text().catch(() => '');
        return googleDriveHttpFailure('drive_list', timestamp, driveRes.status, errText);
      }

      const driveData = (await driveRes.json()) as { files?: any[] };
      const allItems = driveData.files || [];
      const folders = allItems.filter(
        (f) => f.mimeType === 'application/vnd.google-apps.folder'
      );
      const files = allItems.filter(
        (f) => f.mimeType !== 'application/vnd.google-apps.folder'
      );

      return {
        tool: 'google-drive',
        action: 'drive_list',
        status: 'executed' as const,
        message: `Listed ${folders.length} folder${folders.length === 1 ? '' : 's'} and ${files.length} file${files.length === 1 ? '' : 's'} under "${folderName}"`,
        data: {
          folderId,
          folderName,
          folderLink:
            resolved.webViewLink ||
            (folderId === 'root'
              ? 'https://drive.google.com/drive/my-drive'
              : `https://drive.google.com/drive/folders/${folderId}`),
          totalFolders: folders.length,
          totalFiles: files.length,
          // Put folders FIRST so they are prominent and never hidden in truncated JSON
          folders,
          files,
          allItems,
        },
        timestamp,
      };
    }

    // ── 3. DRIVE CREATE FOLDER ────────────────────────────────────────────────
    if (actionName.includes('create_folder') || actionName.includes('mkdir')) {
      const folderName =
        payload.name || payload.folderName || payload.folder_name || payload.title || 'New Folder';
      const rawParent = payload.parentId || payload.parent_id || payload.folderId || 'root';
      const resolvedParent = await resolveFolder(gToken, rawParent);

      const metadata: Record<string, any> = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      };
      if (resolvedParent.id && resolvedParent.id !== 'root') {
        metadata.parents = [resolvedParent.id];
      }

      const createRes = await fetchWithTimeout(
        'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${gToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => '');
        return googleDriveHttpFailure('drive_create_folder', timestamp, createRes.status, errText);
      }

      const newFolder = (await createRes.json()) as any;
      return {
        tool: 'google-drive',
        action: 'drive_create_folder',
        status: 'executed' as const,
        message: `Created Google Drive folder "${folderName}" under "${resolvedParent.name}"`,
        data: {
          folderId: newFolder.id,
          name: folderName,
          webViewLink:
            newFolder.webViewLink || `https://drive.google.com/drive/folders/${newFolder.id}`,
          parentId: resolvedParent.id,
          parentName: resolvedParent.name,
        },
        timestamp,
      };
    }

    // ── 4. DRIVE SHARE / PERMISSIONS ──────────────────────────────────────────
    if (actionName.includes('share') || actionName.includes('permission')) {
      const rawFile = payload.fileId || payload.file_id || payload.id || payload.url;
      const { id: fileId } = extractDriveId(rawFile);
      const targetId = fileId || rawFile;

      if (!targetId) {
        return {
          tool: 'google-drive',
          action: 'drive_share',
          status: 'error' as const,
          message: 'fileId or folderId is required to share a Drive item.',
          data: null,
          timestamp,
        };
      }
      const role = payload.role || 'reader';
      const emailAddress = payload.email || payload.emailAddress;
      const permBody = emailAddress
        ? { role, type: 'user', emailAddress }
        : { role, type: 'anyone' };

      const permRes = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          targetId
        )}/permissions?supportsAllDrives=true`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(permBody),
        }
      );
      if (!permRes.ok) {
        const errText = await permRes.text().catch(() => '');
        return googleDriveHttpFailure('drive_share', timestamp, permRes.status, errText);
      }
      const permData = (await permRes.json()) as any;
      return {
        tool: 'google-drive',
        action: 'drive_share',
        status: 'executed' as const,
        message: `Shared Drive item ${targetId} with ${emailAddress || 'anyone'} (${role})`,
        data: { fileId: targetId, role, emailAddress: emailAddress || 'anyone', permissionId: permData.id },
        timestamp,
      };
    }

    // ── 5. DRIVE READ / GET TEXT (INCL COLAB NOTEBOOK PARSING) ────────────────
    if (actionName.includes('get_text') || actionName.includes('read')) {
      const rawFile = payload.fileId || payload.file_id || payload.id || payload.url;
      const { id: extractedId } = extractDriveId(rawFile);
      let fileId = extractedId || rawFile;

      if (!fileId) {
        return {
          tool: 'google-drive',
          action: 'drive_get_text',
          status: 'error' as const,
          message: 'fileId is required to read a Drive file.',
          data: null,
          timestamp,
        };
      }

      // Check metadata first to detect folder or notebook
      let fileMeta: any = null;
      try {
        const metaRes = await fetchWithTimeout(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            fileId
          )}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${gToken}` } }
        );
        if (!metaRes.ok && (metaRes.status === 401 || metaRes.status === 403)) {
          throw new GoogleDriveHttpError(metaRes.status, await metaRes.text().catch(() => ''));
        }
        if (metaRes.ok) fileMeta = await metaRes.json();
      } catch (err) {
        if (err instanceof GoogleDriveHttpError) throw err;
        // Continue with fallback
      }

      // If item is a folder, list its contents instead of failing
      if (fileMeta?.mimeType === 'application/vnd.google-apps.folder') {
        const folderContents = await execute({
          ...ctx,
          actionName: 'drive_list',
          payload: { folderId: fileId },
        });
        return folderContents;
      }

      const mimeType = payload.mimeType || fileMeta?.mimeType || '';
      const fileName = fileMeta?.name || '';
      const isColab =
        mimeType === 'application/vnd.google.colaboratory' ||
        fileName.toLowerCase().endsWith('.ipynb');

      const exportMime =
        mimeType === 'application/vnd.google-apps.document'
          ? 'text/plain'
          : mimeType === 'application/vnd.google-apps.spreadsheet'
          ? 'text/csv'
          : mimeType === 'application/vnd.google-apps.presentation'
          ? 'text/plain'
          : null;

      const url = exportMime
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            fileId
          )}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            fileId
          )}?alt=media&supportsAllDrives=true`;

      const contentRes = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${gToken}` } });
      if (!contentRes.ok) {
        const errText = await contentRes.text().catch(() => '');
        return googleDriveHttpFailure('drive_get_text', timestamp, contentRes.status, errText);
      }

      let text = exportMime
        ? await contentRes.text()
        : Buffer.from(await contentRes.arrayBuffer()).toString('utf8');

      // Special handling for Jupyter/Colab notebooks: extract code & markdown cells cleanly
      if (isColab) {
        try {
          const nbJson = JSON.parse(text);
          if (Array.isArray(nbJson.cells)) {
            const formattedCells = nbJson.cells.map((cell: any, idx: number) => {
              const cellType = cell.cell_type === 'code' ? 'Code' : 'Markdown';
              const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
              return `--- [Cell ${idx + 1}: ${cellType}] ---\n${source.trim()}`;
            });
            text = formattedCells.join('\n\n');
          }
        } catch {
          // If JSON parse fails, keep raw text
        }
      }

      return {
        tool: 'google-drive',
        action: 'drive_get_text',
        status: 'executed' as const,
        message: `Extracted ${text.length} characters from Drive file "${fileName || fileId}"`,
        data: {
          fileId,
          fileName,
          webViewLink:
            fileMeta?.webViewLink ||
            (isColab
              ? `https://colab.research.google.com/drive/${fileId}`
              : `https://drive.google.com/file/d/${fileId}/view`),
          mimeType: exportMime || mimeType || 'application/octet-stream',
          content: text.slice(0, 10000),
          totalCharacters: text.length,
        },
        timestamp,
      };
    }

    // ── 6. DRIVE UPLOAD ───────────────────────────────────────────────────────
    if (actionName.includes('upload') || actionName.includes('create_file')) {
      const name = payload.name || payload.filename || `darex-file-${Date.now()}.txt`;
      const content = payload.content || payload.text || '';
      const rawParent = payload.parentId || payload.parent_id || payload.folderId;

      let parentId: string | undefined = undefined;
      if (rawParent) {
        const resolved = await resolveFolder(gToken, rawParent);
        if (resolved.id && resolved.id !== 'root') parentId = resolved.id;
      }

      const metadata: Record<string, any> = { name };
      if (parentId) metadata.parents = [parentId];

      const boundary = `drx${Date.now()}`;
      const bodyParts = [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
          metadata
        )}\r\n`,
        `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`,
        `--${boundary}--\r\n`,
      ];
      const body = bodyParts.join('');

      const upRes = await fetchWithTimeout(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${gToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body,
        }
      );
      if (!upRes.ok) {
        const errText = await upRes.text().catch(() => '');
        return googleDriveHttpFailure('drive_upload', timestamp, upRes.status, errText);
      }
      const upData = (await upRes.json()) as any;
      return {
        tool: 'google-drive',
        action: 'drive_upload',
        status: 'executed' as const,
        message: `Uploaded "${name}" to Google Drive`,
        data: {
          fileId: upData.id,
          name,
          webViewLink: upData.webViewLink || `https://drive.google.com/file/d/${upData.id}/view`,
          size: Buffer.byteLength(content),
          parentId: parentId || 'root',
        },
        timestamp,
      };
    }

    return {
      tool: 'google-drive',
      action: actionName,
      status: 'error' as const,
      message: `Unsupported Drive action "${actionName}". Try drive_search, drive_list, drive_create_folder, drive_get_text, drive_upload, drive_share.`,
      data: null,
      timestamp,
    };
  } catch (e: any) {
    if (e instanceof GoogleDriveHttpError) {
      return googleDriveHttpFailure(actionName, timestamp, e.status, e.details);
    }
    console.error('[google-drive] API error:', e.message);
    return {
      tool: 'google-drive',
      action: actionName,
      status: 'error' as const,
      message: `google-drive request failed: ${e.message}`,
      data: null,
      timestamp,
    };
  }
}

export const googleDrive: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
