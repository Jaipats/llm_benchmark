import { createApp, jobs, lakebase, server } from '@databricks/appkit';
import { setupBenchmarkRoutes } from './routes/benchmark-routes';

await createApp({
  plugins: [jobs(), lakebase(), server()],
  onPluginsReady(appkit) {
    setupBenchmarkRoutes(appkit);
  },
});
