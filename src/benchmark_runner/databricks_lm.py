"""lm-evaluation-harness model adapter for Databricks Model Serving chat endpoints.

lm-eval's built-in `local-chat-completions` assumes OpenAI parameter support. Databricks
endpoints front many providers, and they differ: some reject `temperature`, some reject
`stop`, reasoning models return content as a list of reasoning/text blocks and spend
part of `max_tokens` on hidden reasoning. This adapter:

- probes the endpoint once and drops request parameters it rejects (recorded for the run),
- extracts only the final text from block-structured content and strips <think> sections,
- applies the task's stop sequences client-side so truncation is identical across models,
- raises the per-request token budget so reasoning models aren't cut off mid-thought.

Auth goes through the Databricks SDK, so tokens refresh automatically on long runs.
"""

import json
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import openai
from databricks.sdk import WorkspaceClient
from lm_eval.api.model import LM
from lm_eval.api.registry import register_model
from tqdm import tqdm

log = logging.getLogger(__name__)

OPTIONAL_PARAMS = ("temperature", "stop", "top_p")
THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL)
CODE_BLOCK = re.compile(r"```[a-zA-Z0-9_+-]*\n(.*?)(?:```|$)", re.DOTALL)
MIN_TOKEN_CAP = 4096


def content_to_text(content) -> str:
    """Return the final answer text from a chat message `content` field."""
    if content is None:
        return ""
    if isinstance(content, str):
        stripped = content.strip()
        if not stripped.startswith("[{"):
            return THINK_BLOCK.sub("", content).strip()
        try:
            content = json.loads(stripped)
        except json.JSONDecodeError:
            return THINK_BLOCK.sub("", content).strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("text", "output_text"):
                parts.append(block.get("text") or "")
            elif isinstance(block, str):
                parts.append(block)
        return THINK_BLOCK.sub("", "".join(parts)).strip()
    return str(content)


def truncate_at_stops(text: str, stops: list[str]) -> str:
    cut = len(text)
    for s in stops:
        if s:
            i = text.find(s)
            if i != -1:
                cut = min(cut, i)
    return text[:cut]


@register_model("databricks-chat")
class DatabricksChatLM(LM):
    def __init__(
        self,
        endpoint: str,
        num_concurrent: int = 8,
        min_max_tokens: int = 16384,
        respect_stop: bool = True,
        extract_code: bool = False,
        timeout: float = 900.0,
        max_retries: int = 8,
        max_failure_rate: float = 0.2,
        **kwargs,
    ):
        super().__init__()
        self.endpoint = endpoint
        self.num_concurrent = int(num_concurrent)
        self.min_max_tokens = int(min_max_tokens)
        self.token_cap = None  # set if the endpoint rejects our max_tokens
        self.respect_stop = respect_stop
        self.extract_code = extract_code
        self.max_failure_rate = max_failure_rate
        self.client = WorkspaceClient().serving_endpoints.get_open_ai_client(
            timeout=timeout, max_retries=max_retries
        )
        self.unsupported: set[str] = set()
        self.usage = {"prompt_tokens": 0, "completion_tokens": 0, "requests": 0, "failed": 0}
        self._lock = threading.Lock()
        self._probe()

    # --- endpoint capability handling -------------------------------------------------

    def _handle_bad_request(self, err: openai.BadRequestError) -> bool:
        """Adapt to a rejected parameter. Returns True if the request should be retried."""
        msg = str(err).lower()
        with self._lock:
            for p in OPTIONAL_PARAMS:
                if re.search(rf"\b{p}\b", msg) and p not in self.unsupported:
                    log.warning("Endpoint %s rejects '%s'; dropping it for this run", self.endpoint, p)
                    self.unsupported.add(p)
                    return True
            if "max_tokens" in msg or ("maximum" in msg and "token" in msg):
                current = self.token_cap or self.min_max_tokens
                if current > MIN_TOKEN_CAP:
                    self.token_cap = max(MIN_TOKEN_CAP, current // 2)
                    log.warning("Endpoint %s rejects max_tokens=%s; capping at %s", self.endpoint, current, self.token_cap)
                    return True
        return False

    def _probe(self):
        for _ in range(len(OPTIONAL_PARAMS) + 4):
            try:
                self._chat([{"role": "user", "content": "Reply with the word OK."}], ["\n\nEND"], self.min_max_tokens)
                return
            except openai.BadRequestError as e:
                if not self._handle_bad_request(e):
                    raise
        raise RuntimeError(f"Could not find a request shape accepted by endpoint {self.endpoint}")

    @property
    def request_params(self) -> dict:
        sent = {"max_tokens": self.token_cap or f">= {self.min_max_tokens}"}
        if "temperature" not in self.unsupported:
            sent["temperature"] = 0
        if "stop" not in self.unsupported:
            sent["stop"] = "task stop sequences (max 4)"
        return {"sent": sent, "unsupported": sorted(self.unsupported), "usage": self.usage}

    def _chat(self, messages, stops, max_tokens) -> str:
        if self.token_cap:
            max_tokens = min(max_tokens, self.token_cap)
        body = {"model": self.endpoint, "messages": messages, "max_tokens": max_tokens}
        if "temperature" not in self.unsupported:
            body["temperature"] = 0
        if "stop" not in self.unsupported and stops:
            body["stop"] = stops[:4]
        resp = self.client.chat.completions.create(**body)
        with self._lock:
            self.usage["requests"] += 1
            if resp.usage:
                self.usage["prompt_tokens"] += resp.usage.prompt_tokens or 0
                self.usage["completion_tokens"] += resp.usage.completion_tokens or 0
        return content_to_text(resp.choices[0].message.content if resp.choices else None)

    # --- lm-eval interface ---------------------------------------------------------------

    @property
    def tokenizer_name(self) -> str:
        return f"databricks-chat:{self.endpoint}"

    def chat_template(self, chat_template=False) -> str:
        return ""

    def apply_chat_template(self, chat_history, add_generation_prompt: bool = True) -> str:
        return json.dumps(chat_history, ensure_ascii=False)

    def _to_messages(self, context: str) -> list[dict]:
        try:
            messages = json.loads(context)
            if not (isinstance(messages, list) and all(isinstance(m, dict) for m in messages)):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            messages = [{"role": "user", "content": context}]
        # Assistant prefill (lm-eval `gen_prefix`) is rejected by many chat endpoints; drop it.
        while messages and messages[-1].get("role") == "assistant":
            messages = messages[:-1]
        return messages

    def _generate_one(self, request) -> str:
        context, gen_kwargs = request.args[0], dict(request.args[1] or {})
        stops = gen_kwargs.get("until") or []
        if isinstance(stops, str):
            stops = [stops]
        max_tokens = max(int(gen_kwargs.get("max_gen_toks") or 0), self.min_max_tokens)
        messages = self._to_messages(context)
        for _ in range(len(OPTIONAL_PARAMS) + 4):
            try:
                text = self._chat(messages, stops if self.respect_stop else [], max_tokens)
                break
            except openai.BadRequestError as e:
                if not self._handle_bad_request(e):
                    log.warning("Request failed: %s", e)
                    return self._failed()
            except openai.APIError as e:
                log.warning("Request failed after retries: %s", e)
                return self._failed()
        else:
            return self._failed()
        if self.extract_code:
            m = CODE_BLOCK.search(text)
            if m:
                text = m.group(1)
        if self.respect_stop:
            text = truncate_at_stops(text, stops)
        return text

    def _failed(self) -> str:
        with self._lock:
            self.usage["failed"] += 1
        return ""

    def generate_until(self, requests, disable_tqdm: bool = False) -> list[str]:
        with ThreadPoolExecutor(max_workers=self.num_concurrent) as pool:
            results = list(
                tqdm(pool.map(self._generate_one, requests), total=len(requests), disable=disable_tqdm)
            )
        if requests and self.usage["failed"] / max(self.usage["requests"] + self.usage["failed"], 1) > self.max_failure_rate:
            raise RuntimeError(
                f"{self.usage['failed']} requests to {self.endpoint} failed; aborting so a broken run isn't scored"
            )
        return results

    def loglikelihood(self, requests, disable_tqdm: bool = False):
        raise NotImplementedError("Chat endpoints don't expose log-probabilities; use generative tasks.")

    def loglikelihood_rolling(self, requests, disable_tqdm: bool = False):
        raise NotImplementedError("Chat endpoints don't expose log-probabilities; use generative tasks.")
