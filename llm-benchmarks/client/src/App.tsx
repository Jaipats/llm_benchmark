import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TooltipProvider,
} from '@databricks/appkit-ui/react';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { useApi, type Area, type BenchmarkInfo, type SampleLimit } from './api';
import { HistoryPage } from './pages/HistoryPage';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { RunPage } from './pages/RunPage';

interface Catalog {
  benchmarks: BenchmarkInfo[];
  sampleLimits: SampleLimit[];
  areas: Area[];
}

type Tab = 'leaderboard' | 'run' | 'history';

export default function App() {
  const [tab, setTab] = useState<Tab>('leaderboard');
  const catalog = useApi<Catalog>('/api/benchmarks');
  const me = useApi<{ email: string | null }>('/api/whoami');

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background flex flex-col">
        <header className="border-b px-4 md:px-6 py-3 flex items-center gap-3">
          <Gauge className="h-5 w-5 text-primary" aria-hidden />
          <h1 className="text-lg font-semibold text-foreground">LLM Benchmarks</h1>
          <span className="hidden md:inline text-sm text-muted-foreground">
            Public benchmarks for Databricks serving endpoints · lm-evaluation-harness
          </span>
          {me.data?.email && (
            <Badge variant="secondary" className="ml-auto">
              {me.data.email}
            </Badge>
          )}
        </header>

        <main className="flex-1 p-4 md:p-6 max-w-7xl w-full mx-auto">
          {catalog.loading && <Skeleton className="h-64 w-full" />}
          {catalog.error && (
            <Alert variant="destructive">
              <AlertTitle>Could not load the benchmark catalog</AlertTitle>
              <AlertDescription>{catalog.error}</AlertDescription>
            </Alert>
          )}
          {catalog.data && (
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList>
                <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
                <TabsTrigger value="run">Run a benchmark</TabsTrigger>
                <TabsTrigger value="history">Run history</TabsTrigger>
              </TabsList>
              <TabsContent value="leaderboard" className="mt-4">
                <LeaderboardPage
                  benchmarks={catalog.data.benchmarks}
                  areas={catalog.data.areas}
                  sampleLimits={catalog.data.sampleLimits}
                  onRunBenchmark={() => setTab('run')}
                />
              </TabsContent>
              <TabsContent value="run" className="mt-4">
                <RunPage
                  benchmarks={catalog.data.benchmarks}
                  sampleLimits={catalog.data.sampleLimits}
                  onStarted={() => setTab('history')}
                />
              </TabsContent>
              <TabsContent value="history" className="mt-4">
                <HistoryPage benchmarks={catalog.data.benchmarks} />
              </TabsContent>
            </Tabs>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}
