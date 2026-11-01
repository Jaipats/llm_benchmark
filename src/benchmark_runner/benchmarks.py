"""Benchmark catalog: the public benchmarks offered in the app, mapped to lm-evaluation-harness tasks.

All tasks are generative (the model writes its answer), so they work against chat-completions
serving endpoints that don't expose log-probabilities. Keep keys in sync with
app/shared/benchmarks.ts.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Benchmark:
    key: str
    label: str
    category: str
    task: str  # lm-eval task or group name
    metric: str  # headline metric name in lm-eval results
    filter: str  # lm-eval filter the headline metric is reported under
    full_size: int  # number of questions in the full benchmark
    unsafe_code: bool = False  # executes model-generated code (HumanEval)
    respect_stop: bool = True  # truncate responses at the task's stop sequences
    extract_code: bool = False  # keep only the first fenced code block of the response
    needs_hf_token: bool = False  # dataset is gated on Hugging Face


BENCHMARKS: dict[str, Benchmark] = {
    b.key: b
    for b in [
        Benchmark("mmlu_pro", "MMLU-Pro", "Knowledge", "mmlu_pro", "exact_match", "custom-extract", 12032),
        Benchmark(
            "gpqa_diamond", "GPQA Diamond", "Expert reasoning", "gpqa_diamond_cot_zeroshot",
            "exact_match", "flexible-extract", 198, needs_hf_token=True,
        ),
        Benchmark("ifeval", "IFEval", "Instruction following", "ifeval", "prompt_level_strict_acc", "none", 541),
        Benchmark("bbh", "BIG-Bench Hard", "Reasoning", "bbh_cot_zeroshot", "exact_match", "flexible-extract", 6511),
        Benchmark("math500", "MATH-500", "Math", "minerva_math500", "math_verify", "none", 500),
        Benchmark("aime25", "AIME 2025", "Math (competition)", "aime25", "exact_match", "none", 30),
        Benchmark("gsm8k", "GSM8K (CoT)", "Math (grade school)", "gsm8k_cot", "exact_match", "flexible-extract", 1319),
        Benchmark(
            "humaneval", "HumanEval", "Coding", "humaneval_instruct", "pass@1", "create_test", 164,
            unsafe_code=True, respect_stop=False, extract_code=True,
        ),
    ]
}
