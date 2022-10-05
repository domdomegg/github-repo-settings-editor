#!/usr/bin/env node

import _prompts from 'prompts';
import { Octokit } from "@octokit/core";
import type { GraphQlQueryResponseData } from '@octokit/graphql';

// Ctrl+c'ing out of a prompt quits the program
const prompts = ((questions, options) => _prompts(questions, { onCancel: () => { process.exit(1) }, ...options })) as typeof _prompts;

type Repository = Required<NonConformingRepository>

type NonConformingRepository = {
  name: string,
  id: string,
} & Partial<Preferences>

type Preferences = {
  autoMergeAllowed?: boolean,
  deleteBranchOnMerge?: boolean,
  forkingAllowed?: boolean,
  hasIssuesEnabled?: boolean,
  hasProjectsEnabled?: boolean,
  hasWikiEnabled?: boolean,
  mergeCommitAllowed?: boolean,
  rebaseMergeAllowed?: boolean,
  squashMergeAllowed?: boolean,
}

// Prompt the user for a token and return it as a string
const tokenPrompt = async () => {
  console.log('Create a token at https://github.com/settings/tokens/new?scopes=repo')
  const response = await prompts({
    type: 'password',
    name: 'token',
    message: 'GitHub access token:',
    validate: (value: String) =>
      value.startsWith('ghp_') ? true : 'Your token should start with ghp_',
  });
  return response.token;
};

// Prompt the user with a choice to use the GITHUB_TOKEN from their environment, or to enter a token
const getToken = async () => {
  const { token } = await prompts({
    type: 'select',
    name: 'token',
    message: 'How would you like to authenticate?',
    choices: [
      { title: 'Use GITHUB_TOKEN from environment', value: process.env.GITHUB_TOKEN },
      { title: 'Enter a token', value: tokenPrompt },
    ],
  });
  if (typeof token === 'function') {
    return token();
  } else {
    return token;
  }
};

const getLogin = async (octokit: Octokit): Promise<string> => {
  console.log('Logging in...')
  const login = (await octokit.graphql<{ viewer: { login: string } }>(
    `query {
      viewer {
        login
      }
    }`
  )).viewer.login;
  console.log('Logged in as ' + login + '.')
  return login;
}

// If repoConfig (the file repositories.json) exists, read it and return the list of repositories from the repositories key
let repoConfig = 'repositories.json'
const getRepositoriesFromJson = async (): Promise<Repository[]> => {
  const fs = await import('fs').then(m => m.default);
  const path = await import('path').then(m => m.default);
  const repositoriesPath = path.join(process.cwd(), repoConfig);
  if (fs.existsSync(repositoriesPath)) {
    const repositories = JSON.parse(fs.readFileSync(repositoriesPath, 'utf8')).repositories;
    if (repositories) {
      return repositories;
    }
  }
  return [];
};

const getRepositories = async (octokit: Octokit, login: string): Promise<Repository[]> => {
  console.log('Getting repositories from GitHub API...')
  const repositories: Repository[] = [];
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const page: GraphQlQueryResponseData = (
      await octokit.graphql<{
        user: {
          repositories: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            nodes: Repository[];
          };
        };
      }>(
        `query ($login: String!, $after: String) {
        user(login: $login) {
          repositories(affiliations: [OWNER], first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name

              autoMergeAllowed
              deleteBranchOnMerge
              forkingAllowed
              hasIssuesEnabled
              hasProjectsEnabled
              hasWikiEnabled
              mergeCommitAllowed
              rebaseMergeAllowed
              squashMergeAllowed
            }
          }
        }
      }`,
        {
          login,
          after: endCursor,
        },
      )
    ).user.repositories;

    repositories.push(...page.nodes);
    hasNextPage = page.pageInfo.hasNextPage;
    endCursor = page.pageInfo.endCursor;

  }
  console.log('Found ' + repositories.length + ' repositories.');

  // A function that allows the user to filter the repositories
  const getSelections: (repos: Repository[]) => Promise<Repository[]> = async (repos) => {
    const response = await prompts({      type: 'multiselect',
      name: 'selectedRepositories',
      message: 'Which repositories would you like to enforce settings on?',
      choices: repositories.map(repo => ({ title: repo.name, value: repo })),
    });
    console.log('Selected ' + response.selectedRepositories.length + ' repositories.')
    return response.selectedRepositories;
  };

  // Ask the user if they want to filter the repositories
  const { selectRepos } = await prompts({
    type: 'select',
    name: 'selectRepos',
    message: 'Would you like to enforce settings on all repositories?',
    choices: [
      { title: 'Yes', value: true },
      { title: 'No', value: false },
    ],
  });
  if (selectRepos === true) {
    return repositories;
  } else {
    return getSelections(repositories);
  }
};

const getPreferences = async (): Promise<Preferences> => {
  console.log('What are your preferred settings?')

  const properties: (keyof Preferences)[] = ['autoMergeAllowed','deleteBranchOnMerge','forkingAllowed','hasIssuesEnabled','hasProjectsEnabled','hasWikiEnabled','mergeCommitAllowed','rebaseMergeAllowed','squashMergeAllowed'];

  const prefs = await prompts(properties.map(p => ({
    type: 'select',
    name: p,
    message: p === 'forkingAllowed' ? p + ' (only enforceable for org-owned repos):' : p + ':',
    choices: [
      { title: 'Don\'t enforce', value: 'undefined' }, // can't set it to actual undefined, as then prompts returns the index
      { title: 'Yes', value: true },
      { title: 'No', value: false },
    ],
  })))

  // @ts-ignore
  for (const key in prefs) if (prefs[key] === 'undefined') prefs[key] = undefined;

  return prefs;
}

const getNonConformingRepositories = (repositories: Repository[], preferences: Preferences): NonConformingRepository[] => {
  const preferenceEntries = Object.entries(preferences) as [keyof Preferences, boolean | undefined][];
  return repositories
    .filter(repo => preferenceEntries.some(([key, value]) => value !== undefined && repo[key] !== value))
    .map(repo => {
      const result: NonConformingRepository = { id: repo.id, name: repo.name };
      preferenceEntries.forEach(([key, value]) => {
        if (value !== undefined && repo[key] !== value) {
          result[key] = repo[key];
        }
      })
      return result;
    });
}

const getShouldUpdate = async (): Promise<boolean> => {
  return (await prompts({
    type: 'confirm',
    name: 'shouldUpdate',
    message: 'Do you want to automatically update these repositories?',
  })).shouldUpdate;
}

const updateRepositories = async (octokit: Octokit, login: string, repositories: { name: string }[], preferences: Preferences): Promise<void[]> => {
  return Promise.all(repositories.map(repo => updateRepository(octokit, login, repo, preferences)));
}

const updateRepository = async (octokit: Octokit, login: string, repository: { name: string }, preferences: Preferences): Promise<void> => {
  await octokit.request('PATCH /repos/{owner}/{repo}', {
    owner: login,
    repo: repository.name,

    has_issues: preferences.hasIssuesEnabled,
    has_projects: preferences.hasProjectsEnabled,
    has_wiki: preferences.hasWikiEnabled,
    allow_forking: preferences.forkingAllowed,
    allow_squash_merge: preferences.squashMergeAllowed,
    allow_merge_commit: preferences.mergeCommitAllowed,
    allow_rebase_merge: preferences.rebaseMergeAllowed,
    allow_auto_merge: preferences.autoMergeAllowed,
    delete_branch_on_merge: preferences.deleteBranchOnMerge,
  });
  console.log('  Updated ' + repository.name)
}

(async () => {
  const token = await getToken();

  const octokit = new Octokit({ auth: token });
  const login = await getLogin(octokit);
  const repositories = await getRepositories(octokit, login);

  const preferences = await getPreferences();

  const nonConformingRepositories = getNonConformingRepositories(repositories, preferences);

  if (nonConformingRepositories.length === 0) {
    console.log('All your repositories are using your preferred settings. Checked ' + repositories.length + ' repositories.')
    return;
  }

  console.log('Of your repositories, ' + nonConformingRepositories.length + ' differ' + (nonConformingRepositories.length === 1 ? 's' : '') + ' to your preferred settings:')
  nonConformingRepositories.forEach(repo => {
    console.log('  ' + repo.name + ': ' + Object.keys(repo).filter(k => k !== 'name' && k !== 'id').join(', '))
  })

  const shouldUpdate = await getShouldUpdate();

  if (shouldUpdate) {
    await updateRepositories(octokit, login, nonConformingRepositories, preferences)
    console.log('Successfully updated ' + nonConformingRepositories.length + ' repositor' + (nonConformingRepositories.length === 1 ? 'y' : 'ies'));
  }
})()
