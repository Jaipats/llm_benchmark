import {
  Alert,
  AlertDescription,
  AlertTitle,
  BarChart,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@databricks/appkit-ui/react';
import { useMemo, useState } from 'react';
import {
  formatDateTime,
  formatPct,
  sampleLabel,
  useApi,
  type BenchmarkInfo,
  type LeaderboardScore,
  type SampleLimit,
} from '../api';

const DEFAULT_COMPARE = 3;

interface ModelRow {
  endpoint: string;
  scores: Map<string, LeaderboardScore>;
  mean: number;
}

interface LeaderboardPageProps {
  benchmarks: BenchmarkInfo[];
  sampleLimits: SampleLimit[];
  onRunBenchmark: () => void;
}

export function LeaderboardPage({ benchmarks, sampleLimits, onRunBenchmark }: LeaderboardPageProps) {
  const [sampleFilter, setSampleFilter] = useState('any');
  const board = useApi<{ scores: LeaderboardScore[] }>(
    `/api/leaderboard${sampleFilter === 'any' ? '' : `?sampleLimit=${sampleFilter}`}`,
  );
  const [picked, setPicked] = useState<string[] | null>(null);

  const { rows, columns, best, latest, mixedSizes } = useMemo(() => {
    const scores = board.data?.scores ?? [];
    const byModel = new Map<string, Map<string, LeaderboardScore>>();
    for (const s of scores) {
      if (!byModel.has(s.endpoint)) byModel.set(s.endpoint, new Map());
      byModel.get(s.endpoint)!.set(s.benchmark, s);
    }
    const rows: ModelRow[] = [...byModel.entries()]
      .map(([endpoint, m]) => {
        const vals = [...m.values()].map((s) => s.value);
        return { endpoint, scores: m, mean: vals.reduce((a, b) => a + b, 0) / vals.length };
      })
      .sort((a, b) => b.mean - a.mean);
    const columns = benchmarks.filter((b) => scores.some((s) => s.benchmark === b.key));
    const best = new Map(
      columns.map((c) => [c.key, Math.max(...rows.map((r) => r.scores.get(c.key)?.value ?? -1))]),
    );
    const latest = scores.reduce<string | null>((acc, s) => (!acc || s.finished_at > acc ? s.finished_at : acc), null);
    const mixedSizes = new Set(scores.map((s) => s.sample_limit)).size > 1;
    return { rows, columns, best, latest, mixedSizes };
  }, [board.data, benchmarks]);

  const compared = picked ?? rows.slice(0, DEFAULT_COMPARE).map((r) => r.endpoint);
  const togglePick = (endpoint: string, on: boolean) =>
    setPicked(on ? [...compared, endpoint] : compared.filter((e) => e !== endpoint));

  const chartData = useMemo(
    () =>
      columns.map((c) => {
        const row: Record<string, string | number | null> = { benchmark: c.label };
        for (const r of rows.filter((x) => compared.includes(x.endpoint))) {
          const s = r.scores.get(c.key);
          row[r.endpoint] = s ? Math.round(s.value * 1000) / 10 : null;
        }
        return row;
      }),
    [columns, rows, compared],
  );

  const headline = useMemo(() => {
    if (rows.length < 2) return null;
    const wins = new Map<string, number>();
    for (const c of columns) {
      const top = rows.filter((r) => r.scores.get(c.key)?.value === best.get(c.key));
      if (top.length === 1) wins.set(top[0].endpoint, (wins.get(top[0].endpoint) ?? 0) + 1);
    }
    const [leader, n] = [...wins.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    return leader ? `${leader} has the top score on ${n} of ${columns.length} benchmarks` : null;
  }, [rows, columns, best]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{headline ?? 'Headline benchmark scores by model'}</h2>
          <p className="text-sm text-muted-foreground">
            Latest completed run per model and benchmark · source: Lakebase{' '}
            <code className="text-xs">benchmarks</code> schema (copy of the Delta results tables)
            {latest ? ` · newest result ${formatDateTime(latest)}` : ''}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="sample-filter">Sample size</Label>
          <Select value={sampleFilter} onValueChange={setSampleFilter}>
            <SelectTrigger id="sample-filter" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Latest run of any size</SelectItem>
              {sampleLimits.map((s) => (
                <SelectItem key={s.value} value={String(s.value)}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {board.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load scores</AlertTitle>
          <AlertDescription>{board.error}</AlertDescription>
        </Alert>
      )}
      {board.loading && !board.data && <Skeleton className="h-72 w-full" />}

      {board.data && rows.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No completed runs{sampleFilter === 'any' ? '' : ' at this sample size'}</EmptyTitle>
            <EmptyDescription>Benchmark a model and its scores will appear here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onRunBenchmark}>Run a benchmark</Button>
          </EmptyContent>
        </Empty>
      )}

      {rows.length > 0 && (
        <>
          {mixedSizes && (
            <Alert>
              <AlertTitle>Mixed sample sizes</AlertTitle>
              <AlertDescription>
                Some scores come from sampled runs and others from full runs, so they aren&apos;t directly comparable. Pick a
                sample size above to compare like for like.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Comparison — headline score (%), 0–100 scale</CardTitle>
              <CardDescription>
                {compared.length === 0
                  ? 'Tick models in the table below to compare them.'
                  : `Comparing ${compared.length} model${compared.length === 1 ? '' : 's'}; tick models in the table to change the selection.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {compared.length > 0 ? (
                <BarChart
                  data={chartData}
                  xKey="benchmark"
                  yKey={rows.filter((r) => compared.includes(r.endpoint)).map((r) => r.endpoint)}
                  colorPalette="categorical"
                  showLegend
                  height={340}
                  ariaLabel="Headline benchmark scores for the selected models"
                  valueFormatter={(v) => `${v}%`}
                  options={{ yAxis: { min: 0, max: 100 } }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No models selected.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All models</CardTitle>
              <CardDescription>
                Sorted by the mean of the benchmarks each model has run; bold marks the best score in each column. Hover
                a score for sample size, standard error and run time.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">Compare</span>
                    </TableHead>
                    <TableHead>Model</TableHead>
                    {columns.map((c) => (
                      <TableHead key={c.key} className="text-right">
                        <Tooltip>
                          <TooltipTrigger className="cursor-help">{c.label}</TooltipTrigger>
                          <TooltipContent>{c.metric}</TooltipContent>
                        </Tooltip>
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Mean (coverage)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.endpoint}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Compare ${r.endpoint}`}
                          checked={compared.includes(r.endpoint)}
                          onCheckedChange={(v) => togglePick(r.endpoint, v === true)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{r.endpoint}</TableCell>
                      {columns.map((c) => {
                        const s = r.scores.get(c.key);
                        if (!s)
                          return (
                            <TableCell key={c.key} className="text-right text-muted-foreground">
                              —
                            </TableCell>
                          );
                        return (
                          <TableCell
                            key={c.key}
                            className={`text-right tabular-nums ${s.value === best.get(c.key) ? 'font-semibold' : ''}`}
                          >
                            <Tooltip>
                              <TooltipTrigger className="cursor-help">
                                {formatPct(s.value)}
                                {mixedSizes && (
                                  <span className="ml-1 text-xs text-muted-foreground">{sampleLabel(s.sample_limit)}</span>
                                )}
                              </TooltipTrigger>
                              <TooltipContent>
                                n = {s.n_samples ?? '?'} · ± {formatPct(s.stderr)} SE · {sampleLabel(s.sample_limit)} ·{' '}
                                {formatDateTime(s.finished_at)}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums">
                        {formatPct(r.mean)}{' '}
                        <span className="text-xs text-muted-foreground">
                          ({r.scores.size}/{columns.length})
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-3 text-xs text-muted-foreground">
                Means are only comparable between models with the same coverage. Scores use generative (chat) versions
                of each benchmark via lm-evaluation-harness, so they can differ from model-card numbers.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
