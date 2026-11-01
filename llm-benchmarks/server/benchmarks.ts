// Benchmarks offered in the app. Keys must match src/benchmark_runner/benchmarks.py in the job bundle.

export interface BenchmarkInfo {
  key: string;
  label: string;
  category: string;
  area: 'knowledge' | 'reasoning' | 'math' | 'coding' | 'instructions'; // leaderboard grouping
  metric: string;
  fullSize: number;
  subtasks: number; // lm-eval tasks in the suite; sample limits apply per task
  description: string;
  note?: string;
}

export const BENCHMARKS: BenchmarkInfo[] = [
  {
    key: 'mmlu_pro',
    label: 'MMLU-Pro',
    category: 'Knowledge',
    area: 'knowledge',
    metric: 'Accuracy (5-shot CoT)',
    fullSize: 12032,
    subtasks: 14,
    description: '10-option questions across 14 subjects; harder, less saturated successor to MMLU.',
  },
  {
    key: 'gpqa_diamond',
    label: 'GPQA Diamond',
    category: 'Expert reasoning',
    area: 'knowledge',
    metric: 'Accuracy (0-shot CoT)',
    fullSize: 198,
    subtasks: 1,
    description: 'Graduate-level biology, physics and chemistry questions written by domain experts.',
    note: 'Gated dataset: the job needs a Hugging Face token secret.',
  },
  {
    key: 'ifeval',
    label: 'IFEval',
    category: 'Instruction following',
    area: 'instructions',
    metric: 'Prompt-level strict accuracy',
    fullSize: 541,
    subtasks: 1,
    description: 'Verifiable formatting instructions ("answer in 3 bullet points", "no commas", ...).',
  },
  {
    key: 'bbh',
    label: 'BIG-Bench Hard',
    category: 'Reasoning',
    area: 'reasoning',
    metric: 'Exact match (0-shot CoT)',
    fullSize: 6511,
    subtasks: 27,
    description: '27 multi-step reasoning tasks where earlier models trailed humans.',
  },
  {
    key: 'math500',
    label: 'MATH-500',
    category: 'Math',
    area: 'math',
    metric: 'Math-verify accuracy',
    fullSize: 500,
    subtasks: 1,
    description: 'Competition math problems; answers checked for symbolic equivalence.',
  },
  {
    key: 'aime25',
    label: 'AIME 2025',
    category: 'Math (competition)',
    area: 'math',
    metric: 'Exact match',
    fullSize: 30,
    subtasks: 1,
    description: '2025 American Invitational Mathematics Examination; separates frontier reasoning models.',
  },
  {
    key: 'gsm8k',
    label: 'GSM8K (CoT)',
    category: 'Math (grade school)',
    area: 'math',
    metric: 'Exact match (8-shot CoT)',
    fullSize: 1319,
    subtasks: 1,
    description: 'Grade-school word problems. Near-saturated; useful as a sanity check.',
  },
  {
    key: 'humaneval',
    label: 'HumanEval',
    category: 'Coding',
    area: 'coding',
    metric: 'pass@1',
    fullSize: 164,
    subtasks: 1,
    description: 'Python function completion, scored by running unit tests on the generated code.',
  },
];

export const AREAS = [
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'math', label: 'Math' },
  { key: 'coding', label: 'Coding' },
  { key: 'instructions', label: 'Instruction following' },
];

export const BENCHMARK_KEYS = BENCHMARKS.map((b) => b.key) as [string, ...string[]];

// Questions per lm-eval task. MMLU-Pro and BBH are suites, so the limit applies to each subtask.
export const SAMPLE_LIMITS = [
  { value: 10, label: 'Smoke test (10 per task)' },
  { value: 50, label: 'Quick (50 per task)' },
  { value: 200, label: 'Standard (200 per task)' },
  { value: 0, label: 'Full benchmark' },
];
