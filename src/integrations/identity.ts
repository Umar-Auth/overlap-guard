import { gh, linear } from '../clients';
import { config } from '../config';

let cachedGitHubViewer: any | null = null;
let cachedLinearViewer: any | null = null;

export async function getGitHubViewer() {
  if (cachedGitHubViewer) {
    return cachedGitHubViewer;
  }

  const { viewer } = await gh<any>(`
    query {
      viewer {
        login
        name
        url
      }
    }
  `);

  cachedGitHubViewer = viewer;
  return viewer;
}

export async function getLinearCurrentUser() {
  if (cachedLinearViewer) {
    return cachedLinearViewer;
  }

  try {
    const viewer = await linear.viewer;
    cachedLinearViewer = viewer;
    return viewer;
  } catch (err) {
    const users = await linear.users();
    const fallback = users.nodes.find(user => {
      const email = (user.email || '').toLowerCase();
      const name = (user.name || user.displayName || '').toLowerCase();
      return (
        (config.linearMeEmail && email === config.linearMeEmail.toLowerCase()) ||
        (config.linearMeName && name.includes(config.linearMeName.toLowerCase()))
      );
    });

    if (!fallback) {
      throw err;
    }

    cachedLinearViewer = fallback;
    return fallback;
  }
}

