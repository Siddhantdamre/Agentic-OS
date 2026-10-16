import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['sheets_create', 'sheets_read', 'sheets_append_row'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('append') || a.includes('add_row') || a.includes('insert')) return 'draft';
  return 'read';
}

async function googleToken(orgId: string, action: string, timestamp: string) {
  const auth = await resolveGoogleAuth(orgId, 'google-sheets');
  if (auth.kind !== 'connected') {
    return { token: null, authErr: nangoAuthError('google-sheets', action, timestamp, auth) };
  }
  return { token: auth.accessToken as string, authErr: null };
}

/**
 * Robustly parses raw values into a 2D array for Google Sheets:
 * - Markdown tables (| Col 1 | Col 2 |)
 * - Array of objects ([{ col1: 1, col2: 2 }]) -> extracts header row + data rows
 * - CSV / TSV text lines
 * - Array of arrays
 */
export function parseTableValues(raw: unknown): any[][] {
  if (!raw) return [];

  if (typeof raw === 'string') {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const tableRows: string[][] = [];
    for (const line of lines) {
      if (/^\|?[\s\-:|]+\|?$/.test(line)) continue; // skip markdown divider |---|---|
      if (line.includes('|')) {
        const cells = line.split('|').map((c) => c.trim());
        if (cells[0] === '') cells.shift();
        if (cells[cells.length - 1] === '') cells.pop();
        if (cells.length > 0) tableRows.push(cells);
      } else if (line.includes('\t')) {
        tableRows.push(line.split('\t').map((c) => c.trim()));
      } else if (line.includes(',') && !line.startsWith('{')) {
        tableRows.push(line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, '')));
      }
    }
    if (tableRows.length > 0) return tableRows;
    return [[raw]];
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (typeof raw[0] === 'object' && raw[0] !== null && !Array.isArray(raw[0])) {
      return [Object.keys(raw[0]), ...raw.map((obj: any) => Object.values(obj))];
    }
    return raw.map((r) => (Array.isArray(r) ? r : [r]));
  }

  if (typeof raw === 'object' && raw !== null) {
    return [Object.keys(raw), Object.values(raw)];
  }

  return [];
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const { token: gToken, authErr: gAuthErr } = await googleToken(orgId, actionName, timestamp);
  if (!gToken) return gAuthErr ?? notConnected('google-sheets', actionName, timestamp);

  try {
    if (actionName.includes('create')) {
      const title = payload.title || payload.name || 'Untitled Spreadsheet';
      const sheetRes = await fetchWithTimeout('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { title } }),
      });
      if (!sheetRes.ok) {
        return { tool: 'google-sheets', action: 'sheets_create', status: 'error' as const, message: `Sheets create error ${sheetRes.status}: ${await sheetRes.text()}`, data: null, timestamp };
      }
      const sheetData = await sheetRes.json();
      const spreadsheetId = sheetData.spreadsheetId;

      const rawValues = payload.values || payload.rows || payload.data || payload.table;
      const values = parseTableValues(rawValues);

      if (values.length > 0 && spreadsheetId) {
        await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        }).catch((e) => console.warn('[google-sheets] Failed to append initial values:', e?.message));

        // Format header row: freeze row 1, bold text, light slate background
        await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
                  fields: 'gridProperties.frozenRowCount',
                },
              },
              {
                repeatCell: {
                  range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: { red: 0.94, green: 0.96, blue: 0.98 },
                      textFormat: { bold: true, foregroundColor: { red: 0.06, green: 0.09, blue: 0.16 } },
                    },
                  },
                  fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat',
                },
              },
            ],
          }),
        }).catch((e) => console.warn('[google-sheets] Header styling skipped:', e?.message));
      }

      const url = sheetData.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      return {
        tool: 'google-sheets',
        action: 'sheets_create',
        status: 'executed' as const,
        message: `Created Google Sheet "${sheetData.properties?.title}": ${url}`,
        data: { spreadsheetId, title: sheetData.properties?.title, url, rowCount: values.length },
        timestamp,
      };
    }

    const spreadsheetId = payload.spreadsheetId || payload.spreadsheet_id || payload.id || payload.sheetId || payload.sheet_id;
    if (!spreadsheetId) {
      return { tool: 'google-sheets', action: actionName, status: 'error' as const, message: 'spreadsheetId is required for Sheets actions.', data: null, timestamp };
    }
    const range = payload.range || 'Sheet1!A1:Z500';
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    if (actionName.includes('read') || actionName.includes('get') || actionName.includes('fetch')) {
      const valRes = await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
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
        message: `Read ${valData.values?.length || 0} rows from ${range}: ${url}`,
        data: { spreadsheetId, range, rows: valData.values || [], url },
        timestamp,
      };
    }

    if (actionName.includes('append') || actionName.includes('add_row') || actionName.includes('insert')) {
      const rawValues = payload.values || payload.rows || payload.row || payload.data || payload.table;
      let values = parseTableValues(rawValues);
      if (!values.length || !values[0].length) {
        if (payload.value !== undefined || payload.content !== undefined) {
          values = [[payload.value ?? payload.content]];
        }
      }

      if (!values.length || !values[0].length) {
        return { tool: 'google-sheets', action: 'sheets_append_row', status: 'error' as const, message: 'Provide values or rows to append data.', data: null, timestamp };
      }

      const appendRes = await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
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
        message: `Appended ${appendData.updates?.updatedRows || values.length} row(s) to ${range}: ${url}`,
        data: { spreadsheetId, range, updatedRange: appendData.updates?.updatedRange, values: values.slice(0, 10), url },
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
