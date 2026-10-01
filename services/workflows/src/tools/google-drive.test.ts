import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractDriveId, googleDrive, googleDriveHttpFailure } from './google-drive.js';
import { isGoogleScopeSufficient } from './shared.js';

describe('Google Drive Folder Access & Scope Validation', () => {
  describe('extractDriveId', () => {
    test('recognizes root and empty identifiers', () => {
      assert.deepEqual(extractDriveId('root'), { id: 'root', isUrl: false });
      assert.deepEqual(extractDriveId('/'), { id: 'root', isUrl: false });
      assert.deepEqual(extractDriveId(''), { id: null, isUrl: false });
      assert.deepEqual(extractDriveId(null), { id: null, isUrl: false });
    });

    test('extracts folder ID from standard Google Drive folder URLs', () => {
      const url1 = 'https://drive.google.com/drive/folders/1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi';
      assert.deepEqual(extractDriveId(url1), {
        id: '1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi',
        isUrl: true,
      });

      const url2 = 'https://drive.google.com/drive/u/0/folders/1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi?usp=sharing';
      assert.deepEqual(extractDriveId(url2), {
        id: '1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi',
        isUrl: true,
      });

      const url3 = 'https://drive.google.com/open?id=1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi';
      assert.deepEqual(extractDriveId(url3), {
        id: '1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi',
        isUrl: true,
      });
    });

    test('extracts direct alphanumeric folder IDs', () => {
      const rawId = '1_Ou9pXhEto9-LilbwF10XtQ1krGmzkPi';
      assert.deepEqual(extractDriveId(rawId), { id: rawId, isUrl: false });
    });

    test('returns id: null for plain folder names so they are resolved by name lookup', () => {
      assert.deepEqual(extractDriveId('Colab Notebooks'), { id: null, isUrl: false });
      assert.deepEqual(extractDriveId('final_dataset'), { id: null, isUrl: false });
      assert.deepEqual(extractDriveId('My Reports 2026'), { id: null, isUrl: false });
    });
  });

  describe('isGoogleScopeSufficient', () => {
    test('validates drive scope for google-drive', () => {
      const driveScope = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata';
      assert.equal(isGoogleScopeSufficient('google-drive', driveScope), true);

      const readonlyScope = 'https://www.googleapis.com/auth/drive.readonly';
      assert.equal(isGoogleScopeSufficient('google-drive', readonlyScope), true);
    });

    test('rejects gmail-only or calendar-only scopes for google-drive', () => {
      const gmailScope = 'https://www.googleapis.com/auth/gmail.compose https://mail.google.com/';
      assert.equal(isGoogleScopeSufficient('google-drive', gmailScope), false);

      const calScope = 'https://www.googleapis.com/auth/calendar.events';
      assert.equal(isGoogleScopeSufficient('google-drive', calScope), false);
    });

    test('validates documents or drive for google-docs', () => {
      assert.equal(isGoogleScopeSufficient('google-docs', 'https://www.googleapis.com/auth/documents'), true);
      assert.equal(isGoogleScopeSufficient('google-docs', 'https://www.googleapis.com/auth/drive'), true);
      assert.equal(isGoogleScopeSufficient('google-docs', 'https://www.googleapis.com/auth/gmail.readonly'), false);
    });
  });

  describe('googleDrive tool actions', () => {
    test('registers drive_create_folder along with standard actions', () => {
      assert.ok(googleDrive.actions.includes('drive_list'));
      assert.ok(googleDrive.actions.includes('drive_search'));
      assert.ok(googleDrive.actions.includes('drive_create_folder'));
      assert.ok(googleDrive.actions.includes('drive_get_text'));
      assert.ok(googleDrive.actions.includes('drive_upload'));
      assert.ok(googleDrive.actions.includes('drive_share'));
    });

    test('returns draft risk for create_folder and upload', () => {
      assert.equal(googleDrive.risk('drive_create_folder'), 'draft');
      assert.equal(googleDrive.risk('drive_upload'), 'draft');
      assert.equal(googleDrive.risk('drive_share'), 'publish');
      assert.equal(googleDrive.risk('drive_list'), 'read');
      assert.equal(googleDrive.risk('drive_search'), 'read');
    });
  });

  describe('googleDriveHttpFailure (RT-B05)', () => {
    test('Google Drive 401 returns revoked error with connected: false, never executed or empty list', () => {
      const res = googleDriveHttpFailure('drive_list', '2026-09-28T00:00:00.000Z', 401, 'Unauthorized');
      assert.equal(res.status, 'error');
      assert.equal(res.data?.reason, 'revoked');
      assert.equal(res.data?.connected, false);
      assert.notEqual(res.status, 'executed');
    });

    test('Google Drive 403 with insufficient scope returns insufficient_scope error with setupUrl', () => {
      const res = googleDriveHttpFailure('drive_search', '2026-09-28T00:00:00.000Z', 403, 'Request had insufficient authentication scopes');
      assert.equal(res.status, 'error');
      assert.equal(res.data?.reason, 'insufficient_scope');
      assert.equal(res.data?.connected, false);
      assert.ok(typeof res.data?.setupUrl === 'string');
    });

    test('Google Drive 500 returns api_error, never empty list or executed', () => {
      const res = googleDriveHttpFailure('drive_list', '2026-09-28T00:00:00.000Z', 500, 'Internal Server Error');
      assert.equal(res.status, 'error');
      assert.equal(res.data?.reason, 'api_error');
      assert.equal(res.data?.connected, true);
      assert.notEqual(res.status, 'executed');
    });
  });
});

