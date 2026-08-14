import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['drive_search', 'drive_list', 'drive_get_text', 'drive_upload', 'drive_share'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('share') || a.includes('permission')) return 'publish';
  if (a.includes('upload') || a.includes('create_file')) return 'draft';
  return 'read';
}

async function googleToken(orgId: string): Promise<string | null> {
  const gConnId = `${orgId}_google-drive`;
  for (const providerKey of ['google-drive', 'google']) {
    const token = await getNangoAccessToken(gConnId, providerKey);
    if (token) return token;
  }
  return null;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gToken = await googleToken(orgId);
  if (!gToken) return notConnected('google-drive', actionName, timestamp);

  try {
    if (actionName.includes('search') || actionName.includes('find')) {
      const query = payload.query || payload.name || '';
      const qClause = query
        ? `name contains '${query.replace(/'/g, "\\'")}'`
        : `trashed = false`;
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qClause)}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=${payload.maxResults || 25}`,
        { headers: { Authorization: `Bearer ${gToken}` } }
      );
      if (!driveRes.ok) {
        return { tool: 'google-drive', action: 'drive_search', status: 'error' as const, message: `Drive API error ${driveRes.status}: ${await driveRes.text()}`, data: null, timestamp };
      }
      const driveData = await driveRes.json();
      return {
        tool: 'google-drive',
        action: 'drive_search',
        status: 'executed' as const,
        message: `Found ${driveData.files?.length || 0} file${(driveData.files || []).length === 1 ? '' : 's'} in Google Drive`,
        data: { query, files: driveData.files || [] },
        timestamp,
      };
    }

    if (actionName.includes('list')) {
      const folderId = payload.folderId || payload.parentId || 'root';
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed = false`)}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=${payload.maxResults || 50}`,
        { headers: { Authorization: `Bearer ${gToken}` } }
      );
      if (!driveRes.ok) {
        return { tool: 'google-drive', action: 'drive_list', status: 'error' as const, message: `Drive API error ${driveRes.status}: ${await driveRes.text()}`, data: null, timestamp };
      }
      const driveData = await driveRes.json();
      return {
        tool: 'google-drive',
        action: 'drive_list',
        status: 'executed' as const,
        message: `Listed ${driveData.files?.length || 0} files under "${folderId}"`,
        data: { folderId, files: driveData.files || [] },
        timestamp,
      };
    }

    if (actionName.includes('share') || actionName.includes('permission')) {
      const fileId = payload.fileId || payload.id;
      if (!fileId) {
        return { tool: 'google-drive', action: 'drive_share', status: 'error' as const, message: 'fileId is required to share a Drive file.', data: null, timestamp };
      }
      const role = payload.role || 'reader';
      const emailAddress = payload.email;
      const permBody = emailAddress
        ? { role, type: 'user', emailAddress }
        : { role, type: 'anyone' };
      const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(permBody),
      });
      if (!permRes.ok) {
        return { tool: 'google-drive', action: 'drive_share', status: 'error' as const, message: `Drive share error ${permRes.status}: ${await permRes.text()}`, data: null, timestamp };
      }
      const permData = await permRes.json();
      return {
        tool: 'google-drive',
        action: 'drive_share',
        status: 'executed' as const,
        message: `Shared file ${fileId} with ${emailAddress || 'anyone'} (${role})`,
        data: { fileId, role, emailAddress: emailAddress || 'anyone', permissionId: permData.id },
        timestamp,
      };
    }

    if (actionName.includes('get_text') || actionName.includes('read')) {
      const fileId = payload.fileId || payload.id;
      if (!fileId) {
        return { tool: 'google-drive', action: 'drive_get_text', status: 'error' as const, message: 'fileId is required to read a Drive file.', data: null, timestamp };
      }
      const mimeType = payload.mimeType || '';
      const exportMime = mimeType === 'application/vnd.google-apps.document' ? 'text/plain'
        : mimeType === 'application/vnd.google-apps.spreadsheet' ? 'text/csv'
        : mimeType === 'application/vnd.google-apps.presentation' ? 'text/plain'
        : null;
      const url = exportMime
        ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
        : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const contentRes = await fetch(url, { headers: { Authorization: `Bearer ${gToken}` } });
      if (!contentRes.ok) {
        return { tool: 'google-drive', action: 'drive_get_text', status: 'error' as const, message: `Drive read error ${contentRes.status}: ${await contentRes.text()}`, data: null, timestamp };
      }
      const text = (exportMime ? await contentRes.text() : Buffer.from(await contentRes.arrayBuffer()).toString('utf8'));
      return {
        tool: 'google-drive',
        action: 'drive_get_text',
        status: 'executed' as const,
        message: `Extracted ${text.length} characters from Drive file ${fileId}`,
        data: { fileId, mimeType: exportMime || mimeType || 'application/octet-stream', content: text.slice(0, 8000), totalCharacters: text.length },
        timestamp,
      };
    }

    if (actionName.includes('upload') || actionName.includes('create_file')) {
      const name = payload.name || payload.filename || `darex-file-${Date.now()}.txt`;
      const content = payload.content || payload.text || '';
      const parentId = payload.parentId || payload.folderId;
      const metadata: any = { name };
      if (parentId) metadata.parents = [parentId];

      const boundary = `drx${Date.now()}`;
      const bodyParts = [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`,
        `--${boundary}--\r\n`,
      ];
      const body = bodyParts.join('');

      const upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!upRes.ok) {
        return { tool: 'google-drive', action: 'drive_upload', status: 'error' as const, message: `Drive upload error ${upRes.status}: ${await upRes.text()}`, data: null, timestamp };
      }
      const upData = await upRes.json();
      return {
        tool: 'google-drive',
        action: 'drive_upload',
        status: 'executed' as const,
        message: `Uploaded "${name}" to Google Drive`,
        data: { fileId: upData.id, name, webViewLink: upData.webViewLink || null, size: Buffer.byteLength(content) },
        timestamp,
      };
    }

    return { tool: 'google-drive', action: actionName, status: 'error' as const, message: `Unsupported Drive action "${actionName}". Try drive_search, drive_list, drive_get_text, drive_upload, drive_share.`, data: null, timestamp };
  } catch (e: any) {
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
