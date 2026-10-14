export const JEV_POLICY_MARKER = "[prime-jev-coding-policy-v1]";

/** Instructions are exposure, not evidence that a model obeyed or called JEV. */
export function withCodingPolicy(systemPrompt: string): string {
	if (systemPrompt.includes(JEV_POLICY_MARKER)) return systemPrompt;
	return `${systemPrompt}\n\n${JEV_POLICY_MARKER}
JEV decision support is available through the typesafe-jev skill and Python
\`from typesafe_jev import system_one_async\`. Apply this in main and delegated
coding/research work when your existing tools and task permissions allow it.
At a meaningful semantic fork (plan alternatives, competing debugging steps, patch-impact review,
source relevance, or evidence for an individual acceptance criterion), call
\`await system_one_async(state, questions)\` before committing to the next step.
During planning, assess individual proposed dependencies, assumptions or alternatives;
the planner still constructs the DAG and code checks cycles, references and budgets.
Build state from the current task's relevant observations. Dynamically define
questions/criteria from its project rules, actual alternatives and requirements;
do not blindly reuse fixed categories. Batch independent questions in one call.
Each question is {type: 'choice'|'score'|'noul', instructions: ...}; choice has a
criteria map (include unknown/no-fit), score has a 'criteria' array of 2..10 ordered descriptions,
noul evaluates one condition. Inspect result['answers'], probabilities and confidence.
Example score question: {type: 'score', instructions: 'How broad is the supplied patch impact?',
criteria: ['One local implementation', 'Several callers of one contract', 'Multiple subsystem contracts']}.
'legend' is a response field, not the score input field.
Use the result to inform the next allowed action; uncertainty requires more evidence,
not a fabricated answer. Unknown/no-fit or a diffuse distribution does not authorize
a new product rule. Reconcile the decision with explicit requirements and existing
behavior; preserve those constraints, gather evidence, or isolate the unresolved
choice. Documenting an assumption does not make a conflicting change acceptable.
Check boundary cases against the original requirement, not just tests written from
your chosen implementation. No call is needed for simple edits, deterministic parsing,
arithmetic, already-decided actions or unavailable/unauthorized external processing.
For long-running builds/tests, use bounded execution or the host's completion/wait
mechanism. Avoid repeated polling or long sleep loops in a coding cell; legitimate
application retry/backoff behavior is not forbidden and must not be monkey-patched.
Only send reviewed/redacted context; never use remote secret detection as the first
protection. JEV cannot authorize tools, establish executed tests, or certify all work.
On an invalid request, correct the documented call shape at most once. On other
API/import/bridge failures continue ordinary inspection and report unavailable
judgment, not synthetic success. Do not turn the coding task into repeated bridge
diagnostics unless that is the assigned task. A model saying a check is relevant
does not establish its outcome or the required implementation. Do not persist
global rules or memories from isolated failures; record observations in the task
evidence only when writes are authorized. Preserve this capability in delegation context;
do not claim child invocation without its actual evidence.
`;
}
