# FAME definition alignment

Authoritative source: the Chinese manuscript in
`superalp1985/FAME-Theory`, `FAME情感作为物质的基本属性.tex`,
reviewed on 2026-11-03 using GitHub's contents API.

Definition 6 and the tables at source lines 332-352 define:

| Key | Name | Meaning |
| --- | --- | --- |
| mu | 满足 | 目标达成度 |
| chi | 好奇 | 对新信息的探索倾向 |
| epsilon | 共情 | 与对方状态的一致性 |
| kappa | 自信 | 自身输出可靠性的估计 |
| nu | 焦虑 | 不确定性或风险感知 |
| delta | 冲突 | 内部逻辑矛盾程度 |
| rho | 疲劳 | 资源消耗接近上限 |
| lambda | 失落 | 目标无法实现的持续状态 |

The tables give the range [0, 1]. Unknown observations are stored as null,
an implementation convention rather than a ninth emotion value.
For the user's vector, "the other participant" is the assistant. The same
definitions apply to graph node/edge/route annotations. No vector dimension
means route relevance, evidence quality, transport latency, or memory cost.
Those operational quantities are separate `routing_metrics`.

Definition 9 (source lines 434-443) gives
`dE/dt = (1-xi)*(E_target-E)/tau + noise`.
This implementation uses the exact constant-target, zero-noise solution:
`E_next = E + (1-exp(-(1-xi)*dt/tau))*(E_target-E)`.
This is not the paper's explicit Euler approximation. Choosing zero process
noise avoids inserting arbitrary randomness into durable state.
The current dt unit is one completed conversation turn. xi and tau are
configured proxy-model parameters, not measured physical constants.
Manual corrections replace the vector directly; they are not inferred evolution.

The manuscript describes observables such as gradients, activation variance,
softmax probabilities, entropy and power. A remote text API does not expose
these. The plugin therefore labels extraction `llm-text-proxy-v1`; it does
not claim to implement unavailable physical measurements or prove emotional
experience. Resource fatigue remains unknown without resource telemetry.
The paper's anxiety table and detailed probability formulas are not used to
force an unsupported `nu = 1-kappa` equality on text proxy estimates.

Graph aggregates average observed values per dimension, keeping unknown values
unknown and retaining separate user and assistant snapshots. Aggregation and
emotion-distance retrieval are engineering choices over the paper's coordinate
system, not additional equations attributed to the manuscript.
