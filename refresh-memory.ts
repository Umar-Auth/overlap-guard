import 'dotenv/config';

import { refreshMemoryFromObservations } from './src/observation/refreshMemory';

refreshMemoryFromObservations()
  .then(result => {
    console.log(result.updated ? 'Memory refreshed from observations.' : result.reason);
  })
  .catch(err => {
    console.error('Memory refresh failed:', err.message);
    process.exit(1);
  });

