import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['fetch_user_repos', 'create_repo', 'create_issue'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('issue')) return 'send';
  if (a.includes('create')) return 'publish';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const connId = `${orgId}_github`;
  const accessToken = await getNangoAccessToken(connId, 'github');

  if (accessToken) {
    try {
      if (actionName.includes('issue')) {
        const repoArg = payload.repo || payload.repository || payload.full_name;
        const title = payload.title;
        if (!repoArg) {
          return { tool: 'github', action: 'create_issue', status: 'error' as const, message: 'Repository (repo or owner/repo) is required.', data: null, timestamp };
        }
        if (!title) {
          return { tool: 'github', action: 'create_issue', status: 'error' as const, message: 'Issue title is required.', data: null, timestamp };
        }

        const repoParts = repoArg.split('/');
        let fullRepo = repoArg;
        if (repoParts.length === 1) {
          const meRes = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'DareX-AI-Agent' } });
          const me = await meRes.json();
          fullRepo = `${me.login}/${repoParts[0]}`;
        }

        const issueRes = await fetch(`https://api.github.com/repos/${fullRepo}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'DareX-AI-Agent',
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({
            title,
            body: payload.body || payload.description || '',
            labels: payload.labels || [],
          }),
        });

        if (issueRes.ok) {
          const issue = await issueRes.json();
          return {
            tool: 'github',
            action: 'create_issue',
            status: 'executed' as const,
            message: `Created issue #${issue.number} in ${fullRepo}`,
            data: { number: issue.number, title: issue.title, url: issue.html_url, state: issue.state },
            timestamp,
          };
        }
        const issueErr = await issueRes.json().catch(() => ({}));
        return { tool: 'github', action: 'create_issue', status: 'error' as const, message: `GitHub issue creation failed: ${issueRes.status} ${issueErr.message || ''}`, data: null, timestamp };
      }

      if (actionName.includes('create')) {
        const repoName = payload.name || payload.repoName || 'new-repo';
        const isPrivate = payload.private !== undefined ? payload.private : true;

        const createRes = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'DareX-AI-Agent',
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
          },
          body: JSON.stringify({ name: repoName, private: isPrivate })
        });

        if (createRes.ok) {
          const repo = await createRes.json();
          return {
            tool: 'github',
            action: 'create_repo',
            status: 'executed' as const,
            message: `Successfully created repository '${repo.name}' on GitHub`,
            data: {
              name: repo.name,
              full_name: repo.full_name,
              url: repo.html_url,
              private: repo.private
            },
            timestamp,
          };
        } else {
          const errData = await createRes.json().catch(() => ({}));
          return apiError('github', 'create_repo', timestamp, `GitHub repo creation failed: ${createRes.status} ${errData.message || ''}`, { status: createRes.status });
        }
      } else {
        const ghRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=5', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'DareX-AI-Agent' },
        });
        if (ghRes.ok) {
          const repos = await ghRes.json();
          return {
            tool: 'github',
            action: 'fetch_user_repos',
            status: 'executed' as const,
            message: `Fetched ${repos.length} live repositories from connected GitHub account`,
            data: {
              totalRepos: repos.length,
              repositories: repos.map((r: any) => ({ name: r.name, full_name: r.full_name, private: r.private, url: r.html_url })),
            },
            timestamp,
          };
        }
      }
    } catch (e: any) {
      console.error('GitHub API error:', e);
    }
  }

  return notConnected('github', actionName, timestamp);
}

export const github: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
