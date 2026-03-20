import { linear } from '../clients';

export async function findLinearIssues(filePath: string) {
  try {
    const issues = await linear.issues({
      filter: {
        state: { type: { in: ['started', 'unstarted'] } },
      },
    });

    const fileName = filePath.split('/').pop() || filePath;
    return issues.nodes.filter(issue => {
      const text = `${issue.title} ${issue.description || ''}`.toLowerCase();
      return text.includes(filePath.toLowerCase()) || text.includes(fileName.toLowerCase());
    });
  } catch (err: any) {
    console.error('Linear error:', err.message);
    return [];
  }
}
