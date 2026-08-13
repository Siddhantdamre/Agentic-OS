import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['sheets_create', 'sheets_read', 'sheets_append_row'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('append') || a.includes('add_row') || a.includes('insert')) return 'draft';
  return 'read';
}

async function googleToken(orgId: string): Promise<string | null> {
  const gConnId = `${orgId}_google-sheets`;
  for (const providerKey of ['google-sheets', 'google']) {
    const token = await getNangoAccessToken(gConnId, providerKey);
    if (token) return token;
  }
  return null;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gToken = await googleToken(orgId);
  if (!gToken) return notConnected('google-sheets', actionName, timestamp);

  try {
    if (actionName.includes('create')) {
      const title = payload.title || payload.name || 'Untitled Spreadsheet';
      const sheetRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { title } }),
      });
      if (!sheetRes.ok) {
        return { tool: 'google-sheets', action: 'sheets_create', status: 'error' as const, message: `Sheets create error ${sheetRes.status}: ${await sheetRes.text()}`, data: null, timestamp };
      }
      const sheetData = await sheetRes.json();
      return {
        tool: 'google-sheets',
        action: 'sheets_create',
        status: 'executed' as const,
        message: `Created Google Sheet "${sheetData.properties?.title}"`,
        data: { spreadsheetId: sheetData.spreadsheetId, title: sheetData.properties?.title, url: sheetData.spreadsheetUrl },
        timestamp,
      };
    }

    const spreadsheetId = payload.spreadsheetId || payload.id || payload.sheetId;
    if (!spreadsheetId) {
      return { tool: 'google-sheets', action: actionName, status: 'error' as const, message: 'spreadsheetId is required for Sheets actions.', data: null, timestamp };
    }
    const range = payload.range || 'Sheet1!A1:Z500';

    if (actionName.includes('read') || actionName.includes('get') || actionName.includes('fetch')) {
      const valRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      if (!valRes.ok) {
        return { tool: 'google-sheets', action: 'sheets_read', status: 'error' as const, message: `Sheets read error ${valRes.status}: ${await valRes.text()}`, data: null, timestamp };
      }
      const valData = await valRes.json();
      return {
        tool: 'google-sheets',
        action: 'sheets_read',
        status: 'executed' as const,
        message: `Read ${valData.values?.length || 0} rows from ${range}`,
        data: { spreadsheetId, range, rows: valData.values || [] },
        timestamp,
      };
    }

    if (actionName.includes('append') || actionName.includes('add_row') || actionName.includes('insert')) {
      const rawValues = payload.values || payload.rows;
      const row = payload.row;
      let values: any[][];
      if (Array.isArray(rawValues)) {
        if (rawValues.length > 0 && typeof rawValues[0] === 'object' && rawValues[0] !== null && !Array.isArray(rawValues[0])) {
          values = rawValues.map((obj: any) => Object.values(obj));
        } else {
          values = rawValues.length && Array.isArray(rawValues[0]) ? rawValues : [rawValues];
        }
      } else if (typeof rawValues === 'object' && rawValues !== null) {
        values = [Object.values(rawValues)];
      } else if (Array.isArray(row)) {
        values = [row];
      } else if (typeof row === 'object' && row !== null) {
        values = [Object.values(row)];
      } else {
        values = [[payload.value ?? payload.content ?? '']];
      }

      if (!values.length || !values[0].length) {
        return { tool: 'google-sheets', action: 'sheets_append_row', status: 'error' as const, message: 'Provide values (array) or row array to append data.', data: null, timestamp };
      }

      const appendRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      if (!appendRes.ok) {
        return { tool: 'google-sheets', action: 'sheets_append_row', status: 'error' as const, message: `Sheets append error ${appendRes.status}: ${await appendRes.text()}`, data: null, timestamp };
      }
      const appendData = await appendRes.json();
      return {
        tool: 'google-sheets',
        action: 'sheets_append_row',
        status: 'executed' as const,
        message: `Appended ${appendData.updates?.updatedRows || values.length} row(s) to ${range}`,
        data: { spreadsheetId, range, updatedRange: appendData.updates?.updatedRange, values: values.slice(0, 10) },
        timestamp,
      };
    }

    return { tool: 'google-sheets', action: actionName, status: 'error' as const, message: `Unsupported Sheets action "${actionName}". Try sheets_create, sheets_read, sheets_append_row.`, data: null, timestamp };
  } catch (e: any) {
    console.error('[google-sheets] API error:', e.message);
    return {
      tool: 'google-sheets',
      action: actionName,
      status: 'error' as const,
      message: `google-sheets request failed: ${e.message}`,
      data: null,
      timestamp,
    };
  }
}

export const googleSheets: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
