import { gh } from '../clients';
import { config } from '../config';

export async function findGitHubPRs(filePath: string) {
  try {
    const { repository } = await gh<any>(
      `
      query ($owner: String!, $repo: String!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: OPEN, first: $first) {
            nodes {
              title
              url
              author { login }
              files(first: 100) {
                nodes { path }
              }
            }
          }
        }
      }
    `,
      { owner: config.repoOwner, repo: config.repoName, first: 50 }
    );

    return repository.pullRequests.nodes.filter((pr: any) =>
      pr.files.nodes.some((file: any) => file.path.includes(filePath) || filePath.includes(file.path))
    );
  } catch (err: any) {
    console.error('GitHub error:', err.message);
    return [];
  }
}
