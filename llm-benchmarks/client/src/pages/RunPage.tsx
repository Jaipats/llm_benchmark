import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
} from '@databricks/appkit-ui/react';
import { Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { apiFetch, useApi, type BenchmarkInfo, type ModelOption, type SampleLimit } from '../api';

const DEFAULT_SELECTION = ['mmlu_pro', 'gpqa_diamond', 'ifeval', 'bbh', 'math500', 'humaneval'];

function questionCount(b: BenchmarkInfo, limit: number) {
  return limit ? Math.min(b.fullSize, limit * b.subtasks) : b.fullSize;
}

interface RunPageProps {
  benchmarks: BenchmarkInfo[];
  sampleLimits: SampleLimit[];
  onStarted: () => void;
}

export function RunPage({ benchmarks, sampleLimits, onStarted }: RunPageProps) {
  const models = useApi<{ models: ModelOption[] }>('/api/models');
  const [endpoint, setEndpoint] = useState('');
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTION);
  const [sampleLimit, setSampleLimit] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalQuestions = useMemo(
    () => benchmarks.filter((b) => selected.includes(b.key)).reduce((n, b) => n + questionCount(b, sampleLimit), 0),
    [benchmarks, selected, sampleLimit],
  );

  const toggle = (key: string, on: boolean) =>
    setSelected((cur) => (on ? [...cur, key] : cur.filter((k) => k !== key)));

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ endpoint, benchmarks: selected, sampleLimit }),
      });
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run a benchmark</CardTitle>
        <CardDescription>
          Starts the benchmark job against a chat endpoint. Scores are saved to Delta and Lakebase and show up on the
          leaderboard when the run finishes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="model">Model endpoint</Label>
            {models.loading && <Skeleton className="h-9 w-full" />}
            {models.error && (
              <Alert variant="destructive">
                <AlertTitle>Could not list serving endpoints</AlertTitle>
                <AlertDescription>{models.error}</AlertDescription>
              </Alert>
            )}
            {models.data && (
              <Select value={endpoint} onValueChange={setEndpoint}>
                <SelectTrigger id="model" className="w-full">
                  <SelectValue placeholder="Choose a chat endpoint" />
                </SelectTrigger>
                <SelectContent>
                  {models.data.models.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Ready endpoints with the chat task ({models.data?.models.length ?? '…'} available).
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sample-size">Sample size</Label>
            <Select value={String(sampleLimit)} onValueChange={(v) => setSampleLimit(Number(v))}>
              <SelectTrigger id="sample-size" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sampleLimits.map((s) => (
                  <SelectItem key={s.value} value={String(s.value)}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only compare models at the same sample size. Smaller samples have wider error bars.
            </p>
          </div>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Benchmarks</legend>
          <div className="grid gap-3 md:grid-cols-2">
            {benchmarks.map((b) => {
              const id = `bench-${b.key}`;
              return (
                <label
                  key={b.key}
                  htmlFor={id}
                  className="flex gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50"
                >
                  <Checkbox
                    id={id}
                    checked={selected.includes(b.key)}
                    onCheckedChange={(v) => toggle(b.key, v === true)}
                  />
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.label}</span>
                      <Badge variant="outline">{b.category}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {questionCount(b, sampleLimit).toLocaleString()} questions
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">{b.description}</p>
                    <p className="text-xs text-muted-foreground">Score: {b.metric}</p>
                    {b.note && <p className="text-xs text-warning">{b.note}</p>}
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Run not started</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-4">
        <Button onClick={() => void submit()} disabled={!endpoint || selected.length === 0 || submitting}>
          {submitting ? <Spinner /> : <Play className="h-4 w-4" />}
          Start run
        </Button>
        <span className="text-sm text-muted-foreground">
          {selected.length} benchmark{selected.length === 1 ? '' : 's'} · ~{totalQuestions.toLocaleString()} model
          calls{sampleLimit === 0 && totalQuestions > 5000 ? ' — a full run can take several hours' : ''}
        </span>
      </CardFooter>
    </Card>
  );
}
