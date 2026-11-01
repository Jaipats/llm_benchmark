import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Toggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@databricks/appkit-ui/react';
import { Check, ChevronRight, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  formatDateTime,
  formatPct,
  sampleLabel,
  useApi,
  type Area,
  type BenchmarkInfo,
  type LeaderboardScore,
  type SampleLimit,
} from '../api';

// --- scoring helpers ----------------------------------------------------------------------

interface ModelScores {
  endpoint: string;
  servedEntity: string | null;
  scores: Map<string, LeaderboardScore>;
}

interface Scored {
  value: number;
  se: number | null; // standard error of the (mean) score; null if any input lacks one
}

interface RankedModel extends ModelScores {
  rank: number;
  overall: number;
  overallSe: number | null;
  areas: Map<string, Scored>;
}

interface IncompleteModel extends ModelScores {
  missing: string[];
}

const TIE = 0.0005; // scores within 0.05 pts are treated as equal

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Points difference between two 0–1 scores, e.g. "+3.2 pts". */
function formatPts(delta: number, signed = true) {
  const pts = Math.abs(delta * 100).toFixed(1);
  return signed ? `${delta >= 0 ? '+' : '−'}${pts} pts` : `${pts} pts`;
}

/** Mean of several benchmark scores with the standard error of that mean (independent errors). */
function meanScore(scores: LeaderboardScore[]): Scored {
  const value = mean(scores.map((s) => s.value));
  const ses = scores.map((s) => s.stderr);
  const se = ses.every((x): x is number => typeof x === 'number')
    ? Math.sqrt(ses.reduce((a, x) => a + x * x, 0)) / ses.length
    : null;
  return { value, se };
}

/** True when the gap between two scores is larger than ~95% noise. Unknown error counts as clear. */
function isClearGap(a: Scored, b: Scored) {
  if (a.se === null || b.se === null) return true;
  return Math.abs(a.value - b.value) > 1.96 * Math.sqrt(a.se ** 2 + b.se ** 2);
}

/** "+3.2 pts vs X", "tied with X" or "+0.6 pts vs X (within margin of error)". */
function leadNote(top: Scored, next: Scored | undefined, nextName: string | undefined, none: string) {
  if (!next || !nextName) return none;
  if (Math.abs(top.value - next.value) < TIE) return `Tied with ${nextName}`;
  return `${formatPts(top.value - next.value)} vs ${nextName}${isClearGap(top, next) ? '' : ' (within margin of error)'}`;
}

/** Mean score per area over the included benchmarks, only when the model has all of them. */
function areaScores(model: ModelScores, areaBenchmarks: Map<string, string[]>) {
  const out = new Map<string, Scored>();
  for (const [area, keys] of areaBenchmarks) {
    if (keys.length && keys.every((k) => model.scores.has(k))) {
      out.set(area, meanScore(keys.map((k) => model.scores.get(k)!)));
    }
  }
  return out;
}

// --- small presentational pieces ------------------------------------------------------------

function ScoreBar({ value, leader }: { value: number; leader?: boolean }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
      <div
        className={`h-full rounded-full ${leader ? 'bg-primary' : 'bg-primary/40'}`}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${
        rank === 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
      }`}
    >
      {rank}
    </span>
  );
}

function PickCard({
  label,
  model,
  value,
  note,
  highlight,
}: {
  label: React.ReactNode;
  model: string;
  value: number;
  note: string;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? 'border-primary' : ''}>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">{label}</CardDescription>
        <CardTitle className="text-base break-all">{model}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-3xl font-semibold tabular-nums">{formatPct(value)}</div>
        <p className="text-sm text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

// --- page -----------------------------------------------------------------------------------

interface LeaderboardPageProps {
  benchmarks: BenchmarkInfo[];
  areas: Area[];
  sampleLimits: SampleLimit[];
  onRunBenchmark: () => void;
}

export function LeaderboardPage({ benchmarks, areas, sampleLimits, onRunBenchmark }: LeaderboardPageProps) {
  const [sampleFilter, setSampleFilter] = useState('any');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const board = useApi<{ scores: LeaderboardScore[] }>(
    `/api/leaderboard${sampleFilter === 'any' ? '' : `?sampleLimit=${sampleFilter}`}`,
  );

  const view = useMemo(() => {
    const scores = board.data?.scores ?? [];
    const models = new Map<string, ModelScores>();
    for (const s of scores) {
      if (!models.has(s.endpoint)) {
        models.set(s.endpoint, { endpoint: s.endpoint, servedEntity: s.served_entity, scores: new Map() });
      }
      models.get(s.endpoint)!.scores.set(s.benchmark, s);
    }
    const available = benchmarks.filter((b) => scores.some((s) => s.benchmark === b.key));
    const included = available.filter((b) => !excluded.includes(b.key));
    const areaBenchmarks = new Map(
      areas.map((a) => [a.key, included.filter((b) => b.area === a.key).map((b) => b.key)] as const),
    );
    const areaColumns = areas.filter((a) => (areaBenchmarks.get(a.key) ?? []).length > 0);

    const complete: Omit<RankedModel, 'rank'>[] = [];
    const incomplete: IncompleteModel[] = [];
    for (const m of models.values()) {
      const missing = included.filter((b) => !m.scores.has(b.key)).map((b) => b.label);
      if (included.length && missing.length === 0) {
        const o = meanScore(included.map((b) => m.scores.get(b.key)!));
        complete.push({ ...m, overall: o.value, overallSe: o.se, areas: areaScores(m, areaBenchmarks) });
      } else {
        incomplete.push({ ...m, missing });
      }
    }
    complete.sort((a, b) => b.overall - a.overall);
    // Competition ranking: models with equal overall scores share a rank.
    const ranked: RankedModel[] = [];
    complete.forEach((m, i) => {
      const prev = ranked[i - 1];
      ranked.push({ ...m, rank: prev && Math.abs(prev.overall - m.overall) < TIE ? prev.rank : i + 1 });
    });

    // Best model per area among all models that ran every selected benchmark of that area.
    const picks = areaColumns.map((a) => {
      const contenders = [...models.values()]
        .map((m) => ({ m, v: areaScores(m, areaBenchmarks).get(a.key) }))
        .filter((x): x is { m: ModelScores; v: Scored } => x.v !== undefined)
        .sort((x, y) => y.v.value - x.v.value);
      return { area: a, top: contenders[0], runnerUp: contenders[1] };
    });

    const areaLeaders = new Map(
      areaColumns.map((a) => [a.key, Math.max(...ranked.map((r) => r.areas.get(a.key)?.value ?? -1))] as const),
    );
    const latest = scores.reduce<string | null>((acc, s) => (!acc || s.finished_at > acc ? s.finished_at : acc), null);
    const mixedSizes = new Set(scores.map((s) => s.sample_limit)).size > 1;
    return { models, available, included, areaColumns, ranked, incomplete, picks, areaLeaders, latest, mixedSizes };
  }, [board.data, benchmarks, areas, excluded]);

  const { ranked, incomplete, included, available } = view;
  const leader = ranked[0];
  const second = ranked[1];
  const modelA = pickA ?? leader?.endpoint ?? [...view.models.keys()][0] ?? null;
  const modelB = pickB ?? [...view.models.keys()].find((k) => k !== modelA) ?? null;

  const toggleBenchmark = (key: string, on: boolean) =>
    setExcluded((cur) => (on ? cur.filter((k) => k !== key) : [...cur, key]));

  const leaderScore = leader && { value: leader.overall, se: leader.overallSe };
  const secondScore = second && { value: second.overall, se: second.overallSe };
  let headline = 'Leaderboard';
  if (leaderScore && secondScore && !isClearGap(leaderScore, secondScore)) {
    headline = `Too close to call: ${leader.endpoint} vs ${second.endpoint}`;
  } else if (leader && second) {
    headline = `${leader.endpoint} leads by ${formatPts(leader.overall - second.overall, false)}`;
  } else if (leader) {
    headline = `${leader.endpoint} is the only model with all selected benchmarks`;
  }

  return (
    <div className="space-y-8">
      {/* Headline + controls */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">{headline}</h2>
          <p className="text-sm text-muted-foreground">
            Overall score = mean of {included.length} selected benchmark{included.length === 1 ? '' : 's'} · latest
            completed run per model{view.latest ? ` · newest result ${formatDateTime(view.latest)}` : ''}
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

      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">Benchmarks in overall score:</span>
          {available.map((b) => (
            <Toggle
              key={b.key}
              size="sm"
              variant="outline"
              pressed={!excluded.includes(b.key)}
              onPressedChange={(on) => toggleBenchmark(b.key, on)}
              aria-label={`Include ${b.label} in the overall score`}
              className="data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=off]:text-muted-foreground"
            >
              {!excluded.includes(b.key) && <Check className="h-3.5 w-3.5" aria-hidden />}
              {b.label}
            </Toggle>
          ))}
        </div>
      )}

      {board.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load scores</AlertTitle>
          <AlertDescription>{board.error}</AlertDescription>
        </Alert>
      )}
      {board.loading && !board.data && <Skeleton className="h-96 w-full" />}

      {board.data && view.models.size === 0 && (
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

      {view.models.size > 0 && (
        <>
          {view.mixedSizes && (
            <Alert>
              <AlertTitle>Mixed sample sizes</AlertTitle>
              <AlertDescription>
                These scores mix sampled and full runs, so small differences may be noise. Choose a sample size above to
                compare like for like.
              </AlertDescription>
            </Alert>
          )}

          {/* Top picks */}
          <section className="space-y-3" aria-labelledby="top-picks">
            <h3 id="top-picks" className="text-lg font-semibold">
              Top picks
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {leader && (
                <PickCard
                  highlight
                  label={
                    <>
                      <Trophy className="h-4 w-4 text-primary" aria-hidden /> Best overall
                    </>
                  }
                  model={leader.endpoint}
                  value={leader.overall}
                  note={leadNote({ value: leader.overall, se: leader.overallSe }, secondScore, second?.endpoint, 'No other model has the same benchmarks yet')}
                />
              )}
              {view.picks.map(({ area, top, runnerUp }) =>
                top ? (
                  <PickCard
                    key={area.key}
                    label={`Best at ${area.label.toLowerCase()}`}
                    model={top.m.endpoint}
                    value={top.v.value}
                    note={leadNote(top.v, runnerUp?.v, runnerUp?.m.endpoint, 'Only model tested')}
                  />
                ) : null,
              )}
            </div>
          </section>

          {/* Rankings */}
          <Card>
            <CardHeader>
              <CardTitle>Rankings</CardTitle>
              <CardDescription>
                Ranked by overall score. Skill columns average the selected benchmarks in each area; the best in each
                column is bold. Select a row for per-benchmark scores.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {ranked.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No model has run all the selected benchmarks. Deselect some above to rank partial results.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Rank</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="w-60">Overall</TableHead>
                      {view.areaColumns.map((a) => (
                        <TableHead key={a.key} className="w-28 text-right">
                          {a.label}
                        </TableHead>
                      ))}
                      <TableHead className="w-8">
                        <span className="sr-only">Details</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ranked.map((r) => (
                      <TableRow
                        key={r.endpoint}
                        className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
                        tabIndex={0}
                        aria-label={`Rank ${r.rank}: ${r.endpoint}, ${formatPct(r.overall)}. Open details`}
                        onClick={() => setDetail(r.endpoint)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setDetail(r.endpoint);
                          }
                        }}
                      >
                        <TableCell className="py-4">
                          <RankBadge rank={r.rank} />
                        </TableCell>
                        <TableCell className="py-4 font-medium">{r.endpoint}</TableCell>
                        <TableCell className="py-4">
                          <div className="flex items-center gap-3">
                            <span className="w-14 text-right font-semibold tabular-nums">{formatPct(r.overall)}</span>
                            <ScoreBar value={r.overall} leader={r.rank === 1} />
                          </div>
                        </TableCell>
                        {view.areaColumns.map((a) => {
                          const v = r.areas.get(a.key)?.value;
                          const best = v !== undefined && Math.abs(v - (view.areaLeaders.get(a.key) ?? -1)) < TIE;
                          return (
                            <TableCell
                              key={a.key}
                              className={`py-4 text-right tabular-nums ${best ? 'font-semibold' : 'text-muted-foreground'}`}
                            >
                              {formatPct(v)}
                            </TableCell>
                          );
                        })}
                        <TableCell className="py-4 text-muted-foreground">
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {incomplete.length > 0 && (
                <div className="mt-6 space-y-2">
                  <h4 className="text-sm font-medium">Not ranked: missing selected benchmarks</h4>
                  <ul className="divide-y rounded-md border">
                    {incomplete.map((m) => (
                      <li key={m.endpoint}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left hover:bg-muted/50"
                          onClick={() => setDetail(m.endpoint)}
                        >
                          <span className="font-medium">{m.endpoint}</span>
                          <span className="text-xs text-muted-foreground">Missing: {m.missing.join(', ')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          {view.models.size >= 2 && modelA && modelB && (
            <HeadToHead
              models={[...view.models.values()]}
              benchmarks={benchmarks}
              a={modelA}
              b={modelB}
              onChangeA={setPickA}
              onChangeB={setPickB}
            />
          )}
        </>
      )}

      <ModelDetailSheet
        model={detail ? (view.models.get(detail) ?? null) : null}
        benchmarks={benchmarks}
        rank={ranked.find((r) => r.endpoint === detail)?.rank}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}

// --- head to head ---------------------------------------------------------------------------

interface HeadToHeadProps {
  models: ModelScores[];
  benchmarks: BenchmarkInfo[];
  a: string;
  b: string;
  onChangeA: (v: string) => void;
  onChangeB: (v: string) => void;
}

function HeadToHead({ models, benchmarks, a, b, onChangeA, onChangeB }: HeadToHeadProps) {
  const ma = models.find((m) => m.endpoint === a);
  const mb = models.find((m) => m.endpoint === b);
  const rows = benchmarks
    .filter((bm) => ma?.scores.has(bm.key) && mb?.scores.has(bm.key))
    .map((bm) => {
      const va = ma!.scores.get(bm.key)!.value;
      const vb = mb!.scores.get(bm.key)!.value;
      return { bm, va, vb, delta: va - vb };
    });
  const winsA = rows.filter((r) => r.delta > TIE).length;
  const winsB = rows.filter((r) => r.delta < -TIE).length;
  const avgDelta = rows.length ? mean(rows.map((r) => r.delta)) : 0;

  let summary = 'These two models have no benchmarks in common.';
  if (rows.length && winsA === winsB) summary = `Even: ${winsA} win${winsA === 1 ? '' : 's'} each across ${rows.length} shared benchmarks.`;
  else if (rows.length) {
    const [winner, wins] = winsA > winsB ? [a, winsA] : [b, winsB];
    summary = `${winner} wins ${wins} of ${rows.length} shared benchmarks.`;
    if (Math.abs(avgDelta) >= TIE) {
      summary += ` Averaged across them, ${avgDelta > 0 ? a : b} is ${formatPts(avgDelta, false)} higher.`;
    }
  }

  const picker = (id: string, value: string, onChange: (v: string) => void, other: string, swatch: string) => (
    <div className="flex items-center gap-2">
      <span className={`h-3 w-3 rounded-sm ${swatch}`} aria-hidden />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-72" aria-label={id === 'h2h-a' ? 'Left model' : 'Right model'}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models
            .filter((m) => m.endpoint !== other)
            .map((m) => (
              <SelectItem key={m.endpoint} value={m.endpoint}>
                {m.endpoint}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Head to head</CardTitle>
        <CardDescription>{summary}</CardDescription>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          {picker('h2h-a', a, onChangeA, b, 'bg-chart-1')}
          <span className="text-sm text-muted-foreground">vs</span>
          {picker('h2h-b', b, onChangeB, a, 'bg-chart-2')}
        </div>
      </CardHeader>
      {rows.length > 0 && (
        <CardContent>
          <div className="space-y-3">
            {rows.map(({ bm, va, vb, delta }) => (
              <div key={bm.key} className="grid grid-cols-[9rem_1fr_1fr_5.5rem] items-center gap-3">
                <Tooltip>
                  <TooltipTrigger className="cursor-help text-left text-sm font-medium">{bm.label}</TooltipTrigger>
                  <TooltipContent>{bm.metric}</TooltipContent>
                </Tooltip>
                {/* Left model grows leftward from the centre, right model rightward. */}
                <div className="flex items-center justify-end gap-2">
                  <span className={`text-sm tabular-nums ${delta > TIE ? 'font-semibold' : 'text-muted-foreground'}`}>
                    {formatPct(va)}
                  </span>
                  <div className="flex h-3 w-full max-w-64 justify-end rounded-l-sm bg-muted">
                    <div className="h-full rounded-l-sm bg-chart-1" style={{ width: `${va * 100}%` }} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-3 w-full max-w-64 rounded-r-sm bg-muted">
                    <div className="h-full rounded-r-sm bg-chart-2" style={{ width: `${vb * 100}%` }} />
                  </div>
                  <span className={`text-sm tabular-nums ${delta < -TIE ? 'font-semibold' : 'text-muted-foreground'}`}>
                    {formatPct(vb)}
                  </span>
                </div>
                <span className="text-right text-sm tabular-nums text-muted-foreground">
                  {Math.abs(delta) < TIE ? 'tie' : formatPts(delta)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Bars run 0–100%. The last column is the left model minus the right model, in percentage points.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

// --- model detail -----------------------------------------------------------------------------

interface ModelDetailSheetProps {
  model: ModelScores | null;
  benchmarks: BenchmarkInfo[];
  rank?: number;
  onClose: () => void;
}

function ModelDetailSheet({ model, benchmarks, rank, onClose }: ModelDetailSheetProps) {
  return (
    <Sheet open={model !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {model && (
          <>
            <SheetHeader>
              <SheetTitle className="break-all">{model.endpoint}</SheetTitle>
              <SheetDescription>
                {rank ? `Rank #${rank}` : 'Not ranked'}
                {model.servedEntity ? ` · ${model.servedEntity}` : ''}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-6">
              {benchmarks.map((b) => {
                const s = model.scores.get(b.key);
                return (
                  <div key={b.key} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{b.label}</span>
                      <span className="font-semibold tabular-nums">{s ? formatPct(s.value) : '—'}</span>
                    </div>
                    {s ? (
                      <>
                        <ScoreBar value={s.value} leader />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{b.metric}</span>
                          <span>n = {s.n_samples ?? '?'}</span>
                          <span>± {formatPct(s.stderr)} SE</span>
                          <Badge variant="outline">{sampleLabel(s.sample_limit)}</Badge>
                          <span>{formatDateTime(s.finished_at)}</span>
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">Not run yet</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
